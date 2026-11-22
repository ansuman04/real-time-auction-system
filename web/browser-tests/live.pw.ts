import { expect, test, type Route, type APIRequestContext } from '@playwright/test';
import pg from 'pg';
import { createClient } from 'redis';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? process.env.DATABASE_URL! });
const fixtures: string[] = [];
test.afterAll(async () => {
  await pool.query('DELETE FROM bids WHERE auction_slug=ANY($1::text[])', [fixtures]);
  await pool.query('DELETE FROM auctions WHERE slug=ANY($1::text[])', [fixtures]);
  await pool.end();
});
test.beforeEach(async ({ page }) => {
  // Disable only inherited five-second fallback polling. Socket transport,
  // subscription, automatic refresh and HTTP APIs remain real.
  await page.addInitScript(() => {
    sessionStorage.setItem('auction-part-8-active-user', 'jordan-lee');
    const original = window.setTimeout.bind(window);
    window.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) =>
      original(callback, delay === 5000 ? 2147483647 : delay, ...args)) as typeof window.setTimeout;
  });
});
async function publish(slug: string) {
  const redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:56388' });
  redis.on('error', () => {});
  try { await redis.connect(); await redis.publish('auction-part-8:auction-changed', JSON.stringify({ auctionSlug: slug })); }
  finally { if (redis.isOpen) redis.destroy(); }
}
async function fixture(request: APIRequestContext) {
  const response = await request.post('/api/auctions', { data: {
    title: 'Live browser regression', description: 'Isolated regression fixture', category: 'GPUs', condition: 'Used',
    sellerId: 'alex-morgan', location: 'Austin, TX', startingPrice: '100.00', endsAt: new Date(Date.now() + 3600000).toISOString(),
  } });
  expect(response.status()).toBe(201);
  const auction = await response.json();
  fixtures.push(auction.slug);
  return auction.slug as string;
}

test('a notification fetches HTTP state, and bursts do not abort slow reads', async ({ page, request }) => {
  const slug = await fixture(request);
  await page.goto(`/items/${slug}`);
  await expect(page.getByTestId('live-status')).toHaveText('Live updates connected');
  await page.getByLabel('Your bid (USD)').fill('110.00');
  let held: { route: Route; body: string } | undefined;
  let reads = 0;
  await page.route(`**/api/auctions/${slug}`, async (route) => {
    reads++;
    const response = await route.fetch();
    if (reads === 1) held = { route, body: await response.text() };
    else await route.fulfill({ response });
  });
  expect((await request.post(`/api/auctions/${slug}/bids`, { data: { bidderId: 'sam-rivera', amountMinor: 10100 } })).status()).toBe(201);
  await expect.poll(() => Boolean(held)).toBe(true);
  for (const [amountMinor, bidderId] of [[10200, 'taylor-reed'], [10300, 'sam-rivera'], [10400, 'taylor-reed']] as const) {
    expect((await request.post(`/api/auctions/${slug}/bids`, { data: { bidderId, amountMinor } })).status()).toBe(201);
  }
  // Let all three notifications reach the browser while its first GET is held.
  await expect.poll(() => reads).toBe(1);
  await held!.route.fulfill({ body: held!.body, contentType: 'application/json' });
  await expect(page.getByTestId('current-price')).toHaveText('$104.00');
  await expect(page.getByTestId('bid-history-entry')).toHaveCount(4);
  expect(reads).toBe(2);
  await expect(page.getByLabel('Your bid (USD)')).toHaveValue('110.00');
});

test('reconnect joins then fetches bids missed while offline', async ({ page, context, request }) => {
  const slug = await fixture(request);
  await page.goto(`/items/${slug}`);
  await expect(page.getByTestId('live-status')).toHaveText('Live updates connected');
  await context.setOffline(true);
  await expect(page.getByTestId('live-status')).toContainText('reconnecting');
  expect((await request.post(`/api/auctions/${slug}/bids`, { data: { bidderId: 'sam-rivera', amountMinor: 10100 } })).status()).toBe(201);
  await context.setOffline(false);
  await expect(page.getByTestId('current-price')).toHaveText('$101.00');
  await expect(page.getByTestId('live-status')).toHaveText('Live updates connected');
});

test('automatic live reads cannot clear an uncertain POST; explicit successful recovery can', async ({ page, request }) => {
  const slug = await fixture(request);
  await page.goto(`/items/${slug}`);
  await expect(page.getByTestId('live-status')).toHaveText('Live updates connected');
  await page.route(`**/api/auctions/${slug}/bids`, (route) => route.abort('failed'));
  await page.getByLabel('Your bid (USD)').fill('102.00');
  await page.getByRole('button', { name: 'Place bid', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Place bid', exact: true })).toBeDisabled();
  expect((await request.post(`/api/auctions/${slug}/bids`, { data: { bidderId: 'sam-rivera', amountMinor: 10100 } })).status()).toBe(201);
  await expect(page.getByTestId('current-price')).toHaveText('$101.00');
  await expect(page.getByRole('button', { name: 'Place bid', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Your bid (USD)')).toHaveValue('102.00');
  await page.getByRole('button', { name: 'Refresh auction', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Place bid', exact: true })).toBeEnabled();
});

test('after navigation, unrelated changes do not fetch or replace current detail', async ({ page, request }) => {
  const first = await fixture(request), second = await fixture(request);
  await page.goto(`/items/${first}`);
  await expect(page.getByTestId('live-status')).toHaveText('Live updates connected');
  await page.goto(`/items/${second}`);
  await expect(page.getByTestId('live-status')).toHaveText('Live updates connected');
  let reads = 0;
  page.on('request', (request) => { if (new URL(request.url()).pathname === `/api/auctions/${second}`) reads++; });
  await publish(first);
  // An awaited marker notification for the current room establishes ordering.
  await publish(second);
  await expect.poll(() => reads).toBe(1);
  await expect(page.getByTestId('current-price')).toHaveText('$100.00');
});

test('leading bidder controls disable and become available after a live outbid, including identity switches', async ({ page, request }) => {
  const slug = await fixture(request);
  await page.goto(`/items/${slug}`);
  await expect(page.getByTestId('live-status')).toHaveText('Live updates connected');
  await page.getByLabel('Your bid (USD)').fill('101.00');
  await page.getByRole('button', { name: 'Place bid', exact: true }).click();
  await expect(page.getByText('You are the highest bidder. You can bid again after someone outbids you.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Your bid (USD)')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Place bid', exact: true })).toBeDisabled();
  const repeat = await request.post(`/api/auctions/${slug}/bids`, { data: { bidderId: 'jordan-lee', amountMinor: 10200 } });
  expect(repeat.status()).toBe(409);
  expect((await repeat.json()).auction.bidCount).toBe(1);
  await page.getByLabel('Active demo user').selectOption('sam-rivera');
  await expect(page.getByRole('button', { name: 'Place bid', exact: true })).toBeEnabled();
  await page.getByLabel('Active demo user').selectOption('jordan-lee');
  await expect(page.getByRole('button', { name: 'Place bid', exact: true })).toBeDisabled();
  expect((await request.post(`/api/auctions/${slug}/bids`, { data: { bidderId: 'sam-rivera', amountMinor: 10200 } })).status()).toBe(201);
  await expect(page.getByTestId('current-price')).toHaveText('$102.00');
  await expect(page.getByRole('button', { name: 'Place bid', exact: true })).toBeEnabled();
  await page.getByLabel('Your bid (USD)').fill('103.00');
  await page.getByRole('button', { name: 'Place bid', exact: true }).click();
  await expect(page.getByTestId('bid-history-entry')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Place bid', exact: true })).toBeDisabled();
});
