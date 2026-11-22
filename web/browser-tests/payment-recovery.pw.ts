import { expect, test, type Browser, type Page } from '@playwright/test';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? process.env.DATABASE_URL! });
const slugs: string[] = [];
const sellerId = 'payment-seller-' + randomUUID(), winnerId = 'payment-winner-' + randomUUID();
test.beforeAll(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await client.query('LOCK TABLE demo_users IN SHARE ROW EXCLUSIVE MODE');
    const order = (await client.query('SELECT coalesce(max(sort_order),0) AS n FROM demo_users')).rows[0].n;
    await client.query('INSERT INTO demo_users (id,display_name,sort_order) VALUES ($1,$2,$3),($4,$5,$6)',
      [sellerId, 'Payment seller ' + randomUUID(), order + 1, winnerId, 'Payment winner ' + randomUUID(), order + 2]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});
async function fixture() {
  const slug = `payment-review-${randomUUID()}`; slugs.push(slug);
  await pool.query(`INSERT INTO auctions (slug,title,description,category,condition,seller,seller_id,starting_price_minor,ends_at,art)
    VALUES ($1,'Seller payment recovery','Test','Other','Used','Alex Morgan',$2,10000,now()+interval '1 day','chassis')`, [slug, sellerId]);
  const bid = (await pool.query(`INSERT INTO bids (auction_slug,bidder_id,amount_minor,accepted_at) VALUES ($1,$2,12500,now()) RETURNING id`, [slug, winnerId])).rows[0].id;
  await pool.query(`INSERT INTO auction_closes (auction_slug,closed_at,winning_bid_id,winner_id,winning_amount_minor) VALUES ($1,now(),$2,$3,12500)`, [slug, bid, winnerId]);
  return slug;
}
async function view(browser: Browser, slug: string, userId: string) {
  const context = await browser.newContext();
  await context.addInitScript((id) => { sessionStorage.setItem('auction-part-8-active-user', id); }, userId);
  const page = await context.newPage(); await page.goto(`/items/${slug}`); return page;
}
async function pay(page: Page) {
  await page.getByLabel('Card number').fill('4242424242424242');
  await page.getByLabel('Expiration').fill('12 / 30'); await page.getByLabel('CVC', { exact: true }).fill('123');
  await page.getByRole('button', { name: 'Pay $125.00', exact: true }).click();
  await expect(page.getByTestId('checkout-panel')).toContainText('Payment confirmed', { timeout: 15000 });
}
test.afterAll(async () => {
  const paid = await pool.query('SELECT auction_slug FROM purchases WHERE auction_slug=ANY($1) AND paid_at IS NOT NULL', [slugs]);
  for (const row of paid.rows) await expect.poll(async () =>
    (await pool.query('SELECT count(*)::int AS n FROM payment_deliveries WHERE auction_slug=$1', [row.auction_slug])).rows[0].n,
  { timeout: 15000 }).toBe(2);
  await pool.query('DELETE FROM mock_stripe_purchase_ledger WHERE purchase_id IN (SELECT id FROM purchases WHERE auction_slug=ANY($1))', [slugs]);
  await pool.query('DELETE FROM mock_stripe_sessions WHERE purchase_id IN (SELECT id FROM purchases WHERE auction_slug=ANY($1))', [slugs]);
  await pool.query('DELETE FROM payment_webhook_receipts WHERE purchase_id IN (SELECT id FROM purchases WHERE auction_slug=ANY($1))', [slugs]);
  await pool.query('DELETE FROM payment_deliveries WHERE auction_slug=ANY($1)', [slugs]);
  await pool.query('DELETE FROM purchases WHERE auction_slug=ANY($1)', [slugs]);
  await pool.query('DELETE FROM recipient_notifications WHERE auction_slug=ANY($1)', [slugs]);
  await pool.query('DELETE FROM outbox_events WHERE auction_slug=ANY($1)', [slugs]);
  await pool.query('DELETE FROM auction_closes WHERE auction_slug=ANY($1)', [slugs]);
  await pool.query('DELETE FROM bids WHERE auction_slug=ANY($1)', [slugs]);
  await pool.query('DELETE FROM auctions WHERE slug=ANY($1)', [slugs]); await pool.query('DELETE FROM demo_users WHERE id=ANY($1)', [[sellerId, winnerId]]); await pool.end();
});

test('seller receives a private live paid update; stale reads cannot undo it; unrelated users see no payment', async ({ browser }) => {
  const slug = await fixture();
  const seller = await view(browser, slug, sellerId);
  const winner = await view(browser, slug, winnerId);
  const outsider = await view(browser, slug, 'sam-rivera');
  try {
    await expect(seller.getByTestId('checkout-panel')).toContainText('Awaiting payment');
    await expect(seller.getByRole('button', { name: 'Pay now', exact: true })).toHaveCount(0);
    await expect(outsider.getByTestId('checkout-panel')).toHaveCount(0);
    const signals: string[] = [];
    // Reconnect after installing the observer to capture a payment transport.
    seller.on('websocket', (socket) => socket.on('framereceived', ({ payload }) => { if (String(payload).includes('payment:changed')) signals.push(String(payload)); }));
    await seller.reload();
    await expect(seller.getByTestId('checkout-panel')).toContainText('Awaiting payment');
    let held: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { held = resolve; });
    let intercepted = false;
    await seller.route(`**/api/auctions/${slug}/checkout?userId=${sellerId}`, async (route) => {
      if (intercepted) return route.continue();
      intercepted = true; await gate;
      await route.fulfill({ json: { role: 'seller', status: 'unpaid', amountMinor: 12500 } });
    });
    await seller.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => intercepted).toBe(true);
    await winner.getByRole('button', { name: 'Pay now', exact: true }).click(); await pay(winner);
    await expect(seller.getByTestId('checkout-panel')).toContainText('Payment confirmed', { timeout: 15000 });
    await expect.poll(() => signals.length).toBeGreaterThan(0);
    held?.(); await seller.unrouteAll({ behavior: 'wait' });
    await expect(seller.getByTestId('checkout-panel')).toContainText('Paid $125.00');
    await seller.getByTestId('checkout-panel').screenshot({ path: test.info().outputPath('seller-paid.png') });
    const privateStatus = await outsider.request.get(`/api/auctions/${slug}/checkout?userId=sam-rivera`);
    expect(privateStatus.status()).toBe(403);
    const sellerStatus = await seller.request.get(`/api/auctions/${slug}/checkout?userId=${sellerId}`);
    expect(await sellerStatus.json()).toEqual({ role: 'seller', status: 'paid', amountMinor: 12500 });
    await seller.reload(); await expect(seller.getByTestId('checkout-panel')).toContainText('Payment confirmed');
    await seller.getByLabel('Active demo user').selectOption('sam-rivera');
    await expect(seller.getByTestId('checkout-panel')).toHaveCount(0);
  } finally { await Promise.all([seller.context().close(), winner.context().close(), outsider.context().close()]); }
});

test('winner recovers a disappeared unpaid session, and offline seller recovers payment after reconnect', async ({ browser, request }) => {
  const slug = await fixture(); const seller = await view(browser, slug, sellerId); const winner = await view(browser, slug, winnerId);
  try {
    await expect(seller.getByTestId('checkout-panel')).toContainText('Awaiting payment');
    await winner.getByRole('button', { name: 'Pay now', exact: true }).click();
    await expect(winner).toHaveURL(/7108\/checkout\/cs_test_/);
    const oldUrl = winner.url(), oldId = oldUrl.split('/').pop();
    const before = (await pool.query('SELECT id FROM purchases WHERE auction_slug=$1', [slug])).rows[0].id;
    await winner.getByRole('link', { name: 'Cancel', exact: true }).click();
    expect((await request.post(`http://127.0.0.1:7108/v1/checkout/sessions/${oldId}/expire`)).status()).toBe(200);
    await winner.getByRole('button', { name: 'Resume checkout', exact: true }).click();
    await expect(winner).toHaveURL(/7108\/checkout\/cs_test_/);
    expect(winner.url()).not.toBe(oldUrl);
    expect((await request.get(oldUrl)).status()).toBe(404);
    await seller.context().setOffline(true);
    await pay(winner);
    await seller.context().setOffline(false);
    await expect(seller.getByTestId('checkout-panel')).toContainText('Payment confirmed', { timeout: 15000 });
    expect((await pool.query('SELECT id FROM purchases WHERE auction_slug=$1', [slug])).rows[0].id).toBe(before);
    await seller.reload(); await expect(seller.getByTestId('checkout-panel')).toContainText('Paid $125.00');
  } finally { await Promise.all([seller.context().close(), winner.context().close()]); }
});
