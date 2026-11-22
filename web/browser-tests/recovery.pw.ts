import { expect, test, type Page, type Route } from '@playwright/test';
import type { AuctionItem } from '../src/catalog';

const path = '/api/auctions/recovery-fixture';
function auction(): AuctionItem {
  return {
    slug: 'recovery-fixture', title: 'Recovery fixture', description: 'Browser-only fixture', category: 'GPUs', condition: 'Used',
    seller: 'Alex Morgan', sellerId: 'fixture-alex', location: 'Austin, TX', currency: 'USD', art: 'gpu', specs: [],
    startingPriceMinor: 10000, currentPriceMinor: 10000, bidCount: 0, bids: [], isClosed: false, finalOutcome: null,
    endsAt: '2031-01-01T12:00:00.000Z',
  };
}
function withBid(item: AuctionItem): AuctionItem {
  return { ...item, currentPriceMinor: 10100, bidCount: 1, bids: [{ id: '1', bidderId: 'fixture-sam', bidderName: 'Sam Rivera', amountMinor: 10100, acceptedAt: '2030-01-01T00:00:00Z' }] };
}
async function marketplace(page: Page) {
  await page.clock.install({ time: new Date('2030-01-01T00:00:00Z') });
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/users') return route.fulfill({ json: [{ id: 'fixture-jordan', displayName: 'Jordan Lee' }, { id: 'fixture-alex', displayName: 'Alex Morgan' }] });
    if (url.pathname === '/api/capabilities') return route.fulfill({ json: { postAuctions: true, placeBids: true } });
    // No fixture request may reach the real database or mutate a live auction.
    return route.fulfill({ status: 500, json: { message: 'Unexpected fixture request' } });
  });
  await page.addInitScript(() => sessionStorage.setItem('auction-part-8-active-user', 'fixture-jordan'));
}

test('server-closed bid response overrides a lagging client clock and stale open reads', async ({ page }) => {
  await marketplace(page);
  const initial = auction();
  let snapshot = initial;
  let posts = 0;
  await page.route(`**${path}`, (route) => route.fulfill({ json: snapshot }));
  await page.route(`**${path}/bids`, (route) => {
    posts++;
    return route.fulfill({ status: 409, json: { message: 'This auction is closed.', auction: { ...initial, isClosed: true } } });
  });
  await page.goto('/items/recovery-fixture');
  await expect(page.getByRole('button', { name: 'Place bid', exact: true })).toBeEnabled();
  await page.getByLabel('Your bid (USD)').fill('101.00');
  await page.getByRole('button', { name: 'Place bid', exact: true }).click();
  await expect(page.getByTestId('auction-status')).toHaveText('Ended');
  await expect(page.getByLabel('Your bid (USD)')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Place bid', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Your bid (USD)')).toHaveValue('101.00');
  // A read started earlier may still describe an open auction. Never reopen it.
  await page.getByRole('button', { name: 'Refresh auction', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Refresh auction', exact: true })).toBeEnabled();
  await expect(page.getByTestId('auction-status')).toHaveText('Ended');
  expect(posts).toBe(1);
  snapshot = { ...initial, isClosed: true };
  await page.reload();
  await expect(page.getByTestId('auction-status')).toHaveText('Ended');
  await expect(page.getByRole('button', { name: 'Place bid', exact: true })).toBeDisabled();
});

test('closed status on initial detail and catalog reads overrides the local clock', async ({ page }) => {
  await marketplace(page);
  const closed = { ...auction(), isClosed: true };
  await page.route(`**${path}`, (route) => route.fulfill({ json: closed }));
  await page.route('**/api/auctions?*', (route) => route.fulfill({ json: [closed] }));
  await page.goto('/items/recovery-fixture');
  await expect(page.getByTestId('auction-status')).toHaveText('Ended');
  await expect(page.getByRole('button', { name: 'Place bid', exact: true })).toBeDisabled();
  await page.goto('/');
  await expect(page.locator('.product-card .time-pill')).toHaveText('Ended');
});

test('uncertain bids stay blocked through pending/failed refresh and recover only after fresh history loads', async ({ page }) => {
  await marketplace(page);
  const initial = auction();
  let mode: 'initial' | 'pending' | 'success' = 'initial';
  const held: Route[] = [];
  let posts = 0;
  await page.route(`**${path}`, (route) => {
    if (mode === 'pending') { held.push(route); return; }
    return route.fulfill({ json: mode === 'success' ? withBid(initial) : initial });
  });
  await page.route(`**${path}/bids`, (route) => { posts++; return route.abort('failed'); });
  await page.goto('/items/recovery-fixture');
  await page.getByLabel('Your bid (USD)').fill('101.00');
  await page.getByRole('button', { name: 'Place bid', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Place a bid' }).getByRole('status')).toContainText('Acceptance is unconfirmed');
  await expect(page.getByRole('button', { name: 'Place bid', exact: true })).toBeDisabled();
  mode = 'pending';
  await page.getByRole('button', { name: 'Refresh auction', exact: true }).click();
  await expect.poll(() => held.length).toBe(1);
  await expect(page.getByRole('button', { name: 'Place bid', exact: true })).toBeDisabled();
  await held[0].fulfill({ status: 503, json: { message: 'Unavailable' } });
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh auction', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Place bid', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Your bid (USD)')).toHaveValue('101.00');
  expect(posts).toBe(1);
  mode = 'success';
  await page.getByRole('button', { name: 'Refresh auction', exact: true }).click();
  await expect(page.getByTestId('current-price')).toHaveText('$101.00');
  await expect(page.getByTestId('bid-history-entry')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Place bid', exact: true })).toBeEnabled();
  expect(posts).toBe(1);
});

test('initial loads and subsequent polls can take longer than five seconds without being cancelled', async ({ page }) => {
  await marketplace(page);
  const initial = auction();
  const held: Route[] = [];
  let aborted = 0;
  page.on('requestfailed', (request) => { if (new URL(request.url()).pathname === path) aborted++; });
  await page.route(`**${path}`, (route) => { held.push(route); });
  await page.goto('/items/recovery-fixture');
  await expect(page.getByLabel('Active demo user')).toHaveValue('fixture-jordan');
  // Development StrictMode may mount, cancel, and remount once. Count only
  // the active read, then assert that polling introduces no further aborts.
  await expect.poll(() => held.filter((route) => route.request().failure() === null).length).toBe(1);
  const initialRequests = held.length;
  const initialAborts = aborted;
  const initialRead = held[held.length - 1];
  await page.clock.fastForward(6000);
  expect(held).toHaveLength(initialRequests);
  expect(aborted).toBe(initialAborts);
  await initialRead.fulfill({ json: initial });
  await expect(page.getByRole('heading', { name: initial.title, exact: true })).toBeVisible();
  await page.clock.fastForward(5000);
  await expect.poll(() => held.length).toBe(initialRequests + 1);
  const pollRead = held[held.length - 1];
  await page.clock.fastForward(6000);
  expect(held).toHaveLength(initialRequests + 1);
  expect(aborted).toBe(initialAborts);
  await expect(page.getByTestId('current-price')).toHaveText('$100.00');
  await pollRead.fulfill({ json: withBid(initial) });
  await expect(page.getByTestId('current-price')).toHaveText('$101.00');
  await expect(page.getByTestId('bid-history-entry')).toHaveCount(1);
});
