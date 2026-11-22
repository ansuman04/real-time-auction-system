import { expect, test } from '@playwright/test';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? process.env.DATABASE_URL! });
const slugs: string[] = [];
test.afterAll(async () => {
  const paid = await pool.query('SELECT auction_slug FROM purchases WHERE auction_slug=ANY($1) AND paid_at IS NOT NULL', [slugs]);
  for (const row of paid.rows) await expect.poll(async () =>
    (await pool.query('SELECT count(*)::int AS n FROM payment_deliveries WHERE auction_slug=$1', [row.auction_slug])).rows[0].n,
  { timeout: 15000 }).toBe(2);
  await pool.query('DELETE FROM mock_stripe_purchase_ledger WHERE purchase_id IN (SELECT id FROM purchases WHERE auction_slug=ANY($1))', [slugs]);
  await pool.query('DELETE FROM payment_deliveries WHERE auction_slug=ANY($1)', [slugs]);
  await pool.query('DELETE FROM mock_stripe_sessions WHERE purchase_id IN (SELECT id FROM purchases WHERE auction_slug=ANY($1))', [slugs]);
  await pool.query('DELETE FROM payment_webhook_receipts WHERE purchase_id IN (SELECT id FROM purchases WHERE auction_slug=ANY($1))', [slugs]);
  await pool.query('DELETE FROM purchases WHERE auction_slug=ANY($1)', [slugs]);
  await pool.query('DELETE FROM recipient_notifications WHERE auction_slug=ANY($1)', [slugs]);
  await pool.query('DELETE FROM outbox_events WHERE auction_slug=ANY($1)', [slugs]);
  await pool.query('DELETE FROM auction_closes WHERE auction_slug=ANY($1)', [slugs]);
  await pool.query('DELETE FROM bids WHERE auction_slug=ANY($1)', [slugs]);
  await pool.query('DELETE FROM auctions WHERE slug=ANY($1)', [slugs]);
  await pool.end();
});

test('winner can cancel, decline, retry and pay the server-owned total; refresh preserves payment', async ({ page, request }) => {
  const slug = `browser-checkout-${randomUUID()}`; slugs.push(slug);
  await pool.query(`INSERT INTO auctions (slug,title,description,category,condition,seller,seller_id,starting_price_minor,ends_at,art)
    VALUES ($1,'Winner checkout review','Test checkout','Other','Used','Alex Morgan','alex-morgan',10000,now()+interval '1 day','chassis')`, [slug]);
  const bid = (await pool.query(`INSERT INTO bids (auction_slug,bidder_id,amount_minor,accepted_at)
    VALUES ($1,'jordan-lee',12500,now()-interval '2 minutes') RETURNING id`, [slug])).rows[0].id;
  await pool.query(`INSERT INTO auction_closes (auction_slug,closed_at,winning_bid_id,winner_id,winning_amount_minor)
    VALUES ($1,now(),$2,'jordan-lee',12500)`, [slug, bid]);
  expect((await request.post(`/api/auctions/${slug}/checkout`, { data: { buyerId: 'alex-morgan' } })).status()).toBe(403);
  expect((await request.post(`/api/auctions/${slug}/checkout`, { data: { buyerId: 'jordan-lee', amountMinor: 1 } })).status()).toBe(400);
  await page.addInitScript(() => sessionStorage.setItem('auction-part-8-active-user', 'jordan-lee'));
  await page.goto(`/items/${slug}?checkout=success`);
  await expect(page.getByTestId('checkout-panel')).not.toContainText('Payment confirmed');
  await page.getByRole('button', { name: 'Pay now', exact: true }).click();
  await expect(page).toHaveURL(/7108\/checkout\/cs_test_/);
  const hostedUrl = page.url();
  await expect(page.getByRole('button', { name: 'Pay $125.00', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Cancel', exact: true }).click();
  await expect(page.getByTestId('checkout-panel')).toContainText('Checkout canceled');
  await page.getByRole('button', { name: 'Resume checkout', exact: true }).click();
  await expect(page).toHaveURL(hostedUrl);
  await page.getByLabel('Card number').fill('4000000000000002');
  await page.getByLabel('Expiration').fill('12 / 30');
  await page.getByLabel('CVC').fill('123');
  await page.getByRole('button', { name: 'Pay $125.00', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('declined');
  await page.getByLabel('Card number').fill('4242424242424242');
  await page.getByRole('button', { name: 'Pay $125.00', exact: true }).click();
  await expect(page.getByTestId('checkout-panel')).toContainText('Payment confirmed', { timeout: 15000 });
  await expect(page.getByTestId('checkout-panel')).toContainText('Paid $125.00');
  await page.reload();
  await expect(page.getByTestId('checkout-panel')).toContainText('Payment confirmed');
  await page.getByLabel('Active demo user').selectOption('alex-morgan');
  await expect(page.getByTestId('checkout-panel')).toContainText('Payment confirmed');
  await expect(page.getByRole('button', { name: 'Pay now', exact: true })).toHaveCount(0);
});

test('disables checkout while starting and does not redirect after switching identity', async ({ page }) => {
  const slug = `browser-checkout-${randomUUID()}`; slugs.push(slug);
  await pool.query(`INSERT INTO auctions (slug,title,description,category,condition,seller,seller_id,starting_price_minor,ends_at,art)
    VALUES ($1,'Pending checkout review','Test','Other','Used','Alex Morgan','alex-morgan',10000,now()+interval '1 day','chassis')`, [slug]);
  const bid = (await pool.query(`INSERT INTO bids (auction_slug,bidder_id,amount_minor,accepted_at) VALUES ($1,'jordan-lee',12500,now()-interval '2 minutes') RETURNING id`, [slug])).rows[0].id;
  await pool.query(`INSERT INTO auction_closes (auction_slug,closed_at,winning_bid_id,winner_id,winning_amount_minor) VALUES ($1,now(),$2,'jordan-lee',12500)`, [slug, bid]);
  await page.addInitScript(() => sessionStorage.setItem('auction-part-8-active-user', 'jordan-lee'));
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/api/auctions/${slug}/checkout`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await gate;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'pending', url: 'http://127.0.0.1:7108/checkout/cs_test_fake' }) });
  });
  await page.goto(`/items/${slug}`);
  await page.getByRole('button', { name: 'Pay now', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Starting checkout…', exact: true })).toBeDisabled();
  await page.getByLabel('Active demo user').selectOption('sam-rivera');
  release?.();
  await expect(page.getByTestId('checkout-panel')).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/items/${slug}$`));
});
