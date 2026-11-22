import { expect, test, type APIRequestContext } from '@playwright/test';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? process.env.DATABASE_URL! });
const slugs: string[] = [];
const sellerId = 'notice-seller-' + randomUUID(), winnerId = 'notice-winner-' + randomUUID();
const winnerName = 'Notice winner ' + randomUUID();
test.beforeAll(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await client.query('LOCK TABLE demo_users IN SHARE ROW EXCLUSIVE MODE');
    const order = (await client.query('SELECT coalesce(max(sort_order),0) AS n FROM demo_users')).rows[0].n;
    await client.query('INSERT INTO demo_users (id,display_name,sort_order) VALUES ($1,$2,$3),($4,$5,$6)',
      [sellerId, 'Notice seller ' + randomUUID(), order + 1, winnerId, winnerName, order + 2]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});
test.afterAll(async () => {
  await pool.query('DELETE FROM recipient_notifications WHERE auction_slug=ANY($1::text[])', [slugs]);
  await pool.query('DELETE FROM outbox_events WHERE auction_slug=ANY($1::text[])', [slugs]);
  await pool.query('DELETE FROM auction_closes WHERE auction_slug=ANY($1::text[])', [slugs]);
  await pool.query('DELETE FROM bids WHERE auction_slug=ANY($1::text[])', [slugs]);
  await pool.query('DELETE FROM auctions WHERE slug=ANY($1::text[])', [slugs]);
  await pool.query('DELETE FROM demo_users WHERE id=ANY($1)', [[sellerId, winnerId]]);
  await pool.end();
});

async function createAuction(request: APIRequestContext, withBid: boolean) {
  const response = await request.post('/api/auctions', { data: {
    title: `Notification review ${randomUUID()}`, description: 'Short lived auction for notification review.',
    category: 'Other', condition: 'Used', sellerId, location: 'Review fixture',
    startingPrice: '100.00', endsAt: new Date(Date.now() + 8_000).toISOString(),
  } });
  expect(response.status()).toBe(201);
  const auction = await response.json() as { slug: string };
  slugs.push(auction.slug);
  if (withBid) expect((await request.post(`/api/auctions/${auction.slug}/bids`, {
    data: { bidderId: winnerId, amountMinor: 12500 },
  })).status()).toBe(201);
  return auction.slug;
}

test('delivers winner and seller popup modals and remembers explicit dismissal', async ({ browser, request }) => {
  const slug = await createAuction(request, true);
  const seller = await browser.newPage();
  const winner = await browser.newPage();
  await seller.addInitScript((id) => sessionStorage.setItem('auction-part-8-active-user', id), sellerId);
  await winner.addInitScript((id) => sessionStorage.setItem('auction-part-8-active-user', id), winnerId);
  await Promise.all([seller.goto('/'), winner.goto('/')]);
  await expect(seller.getByLabel('Active demo user')).toHaveValue(sellerId);
  await expect(winner.getByLabel('Active demo user')).toHaveValue(winnerId);
  await expect(seller.getByRole('dialog')).toContainText(winnerName + ' won', { timeout: 30_000 });
  await expect(winner.getByRole('dialog')).toContainText('You won', { timeout: 30_000 });
  await seller.getByRole('button', { name: 'Dismiss' }).click();
  await expect(seller.getByRole('dialog')).toHaveCount(0);
  await seller.reload();
  await expect(seller.getByRole('dialog')).toHaveCount(0);
  await winner.getByRole('button', { name: 'Dismiss' }).click();
  await seller.close();
  await winner.close();
});

test('shows the seller a no-bid popup without a winner delivery', async ({ browser, request }) => {
  const slug = await createAuction(request, false);
  const seller = await browser.newPage();
  await seller.addInitScript((id) => sessionStorage.setItem('auction-part-8-active-user', id), sellerId);
  await seller.goto('/');
  await expect(seller.getByRole('dialog')).toContainText('closed without any bids', { timeout: 30_000 });
  const recipients = await pool.query('SELECT recipient_id FROM recipient_notifications WHERE auction_slug=$1', [slug]);
  expect(recipients.rows).toEqual([{ recipient_id: sellerId }]);
  await seller.getByRole('button', { name: 'Dismiss' }).click();
  await seller.close();
});

test('replays a persisted winner popup when the recipient connects after close', async ({ browser, request }) => {
  const slug = await createAuction(request, true);
  await expect.poll(async () => (await pool.query('SELECT count(*)::int AS count FROM recipient_notifications WHERE auction_slug=$1', [slug])).rows[0].count,
    { timeout: 30_000 }).toBe(2);
  const winner = await browser.newPage();
  await winner.addInitScript((id) => sessionStorage.setItem('auction-part-8-active-user', id), winnerId);
  await winner.goto('/');
  await expect(winner.getByRole('dialog')).toContainText('You won', { timeout: 10_000 });
  await winner.getByRole('button', { name: 'Dismiss' }).click();
  await expect.poll(async () => (await pool.query(`SELECT dismissed_at IS NOT NULL AS dismissed
    FROM recipient_notifications WHERE auction_slug=$1 AND recipient_id=$2`, [slug, winnerId])).rows[0]?.dismissed).toBe(true);
  await winner.close();
});
