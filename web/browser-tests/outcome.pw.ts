import { expect, test, type APIRequestContext } from '@playwright/test';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? process.env.DATABASE_URL! });
const slugs: string[] = [];

test.afterAll(async () => {
  await pool.query('DELETE FROM recipient_notifications WHERE auction_slug=ANY($1::text[])', [slugs]);
  await pool.query('DELETE FROM outbox_events WHERE auction_slug=ANY($1::text[])', [slugs]);
  await pool.query('DELETE FROM auction_closes WHERE auction_slug=ANY($1::text[])', [slugs]);
  await pool.query('DELETE FROM bids WHERE auction_slug=ANY($1::text[])', [slugs]);
  await pool.query('DELETE FROM auctions WHERE slug=ANY($1::text[])', [slugs]);
  await pool.end();
});

async function createAuction(request: APIRequestContext, endInMs: number) {
  const response = await request.post('/api/auctions', { data: {
    title: `Outcome review ${randomUUID()}`,
    description: 'Short-lived auction for final outcome review.',
    category: 'Other', condition: 'Used', sellerId: 'alex-morgan',
    location: 'Review fixture', startingPrice: '100.00',
    endsAt: new Date(Date.now() + endInMs).toISOString(),
  } });
  expect(response.status()).toBe(201);
  const item = await response.json() as { slug: string };
  slugs.push(item.slug);
  return item.slug;
}

async function openAuction(page: import('@playwright/test').Page, slug: string) {
  await page.addInitScript(() => sessionStorage.setItem('auction-part-8-active-user', 'jordan-lee'));
  await page.goto(`/items/${slug}`);
}

test('shows the recorded winner and amount on the ended auction page', async ({ page, request }) => {
  const slug = await createAuction(request, 15_000);
  const bid = await request.post(`/api/auctions/${slug}/bids`, { data: { bidderId: 'jordan-lee', amountMinor: 10100 } });
  expect(bid.status()).toBe(201);
  await openAuction(page, slug);
  await expect(page.getByTestId('final-outcome')).toContainText('Jordan Lee won at $101.00', { timeout: 30_000 });
});

test('shows an explicit no-bids result for an ended auction without bids', async ({ page, request }) => {
  const slug = await createAuction(request, 10_000);
  await openAuction(page, slug);
  await expect(page.getByTestId('final-outcome')).toContainText('No bids were placed. This auction closed without a winner.', { timeout: 30_000 });
});
