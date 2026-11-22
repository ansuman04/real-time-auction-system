import { expect, test } from '@playwright/test';
import pg from 'pg';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface JaegerSpan { operationName: string; tags: { key: string; value: unknown }[] }
interface JaegerTrace { spans: JaegerSpan[] }

test('golden journey exports bid, close, notification, checkout, mock payment and paid evidence to Jaeger', async ({ page, browser, request }) => {
  test.setTimeout(70_000);
  const evidence = await mkdtemp(join(tmpdir(), 'part8-golden-trace-'));
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL! });
  const sellerContext = await browser.newContext({ baseURL: 'http://localhost:5108' });
  await sellerContext.addInitScript(() => sessionStorage.setItem('auction-part-8-active-user', 'alex-morgan'));
  const seller = await sellerContext.newPage();
  await page.addInitScript(() => { if (!sessionStorage.getItem('auction-part-8-active-user')) sessionStorage.setItem('auction-part-8-active-user', 'sam-rivera'); });
  const response = await request.post('/api/auctions', { data: { title: 'Golden trace review', description: 'Trace the complete winning purchase.', category: 'Other', condition: 'Used', sellerId: 'alex-morgan', location: 'Austin, TX', startingPrice: '100.00', endsAt: new Date(Date.now() + 20_000).toISOString() } });
  expect(response.status()).toBe(201);
  const { slug } = await response.json();
  try {
    await seller.goto(`/items/${slug}`);
    await page.goto(`/items/${slug}`);
    await page.getByLabel('Your bid (USD)').fill('101.00');
    await page.getByRole('button', { name: 'Place bid', exact: true }).click();
    await expect(page.getByTestId('current-price')).toHaveText('$101.00');
    await page.getByLabel('Active demo user').selectOption('jordan-lee');
    await page.getByLabel('Your bid (USD)').fill('125.00');
    await page.getByRole('button', { name: 'Place bid', exact: true }).click();
    await expect(page.getByTestId('current-price')).toHaveText('$125.00');
    await expect(page.getByRole('dialog')).toContainText('You won', { timeout: 30_000 });
    await expect(seller.getByRole('dialog')).toContainText('won');
    await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await seller.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await page.getByRole('button', { name: 'Pay now', exact: true }).click();
    await expect(page).toHaveURL(/7108\/checkout\/cs_test_/);
    await page.getByLabel('Card number').fill('4000000000000002');
    await page.getByLabel('Expiration').fill('12 / 30');
    await page.getByLabel('CVC').fill('123');
    await page.getByRole('button', { name: 'Pay $125.00', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('declined');
    await page.getByLabel('Card number').fill('4242424242424242');
    await page.getByRole('button', { name: 'Pay $125.00', exact: true }).click();
    await expect(page.getByTestId('checkout-panel')).toContainText('Payment confirmed', { timeout: 15_000 });
    await expect(seller.getByTestId('checkout-panel')).toContainText('Paid $125.00');
    await page.reload();
    await expect(page.getByTestId('checkout-panel')).toContainText('Paid $125.00');
    const row = (await pool.query(`SELECT c.trace_context AS winning,p.trace_context AS checkout,p.id AS purchase_id
      FROM auction_closes c JOIN purchases p USING(auction_slug) WHERE auction_slug=$1`, [slug])).rows[0];
    const ids = [row.winning.traceparent.split('-')[1], row.checkout.traceparent.split('-')[1]];
    const traces: JaegerTrace[] = [];
    for (const [index, id] of ids.entries()) {
      let data: { data?: JaegerTrace[] } = {};
      const required = index === 0 ? ['notification.emit', 'web.notification.received'] : ['purchase.paid', 'payment.signal', 'payment.emit', 'web.payment.received', 'messaging.process', 'outbox.publish'];
      await expect.poll(async () => {
        const result = await request.get(`http://localhost:16688/api/traces/${id}`);
        data = await result.json();
        const names = data.data?.[0]?.spans?.map(s => s.operationName) ?? [];
        return required.every(name => names.includes(name));
      }, { timeout: 12_000 }).toBe(true);
      traces.push(data.data![0]);
    }
    const spans = traces.flatMap(t => t.spans);
    const names = spans.map(s => s.operationName);
    for (const name of ['web.bid','auction.bid','auction.close','outbox.publish','messaging.process','notification.signal','notification.emit','web.checkout','purchase.checkout','mock-stripe.checkout.create','mock-stripe.payment.attempt','mock-stripe.webhook.send','purchase.webhook','purchase.paid']) expect(names).toContain(name);
    expect(names.some(n => n.startsWith('postgresql.'))).toBe(true);
    const decline = spans.find(s => s.tags.some((t) => t.key === 'mock_stripe.payment.outcome' && t.value === 'declined'));
    expect(decline).toBeDefined();
    if (!decline) throw new Error('Missing decline span');
    expect(decline.tags.some((t) => t.key === 'error' && t.value === true)).toBe(false);
    const exported = JSON.stringify(traces);
    for (const value of ['Alex Morgan', 'Jordan Lee', 'jordan-lee', '4242424242424242','4000000000000002','SELECT ', 'INSERT ', 'cardNumber','x-stripe-signature']) expect(exported).not.toContain(value);
    await writeFile(join(evidence, 'traces.json'), JSON.stringify(traces, null, 2));
    await writeFile(join(evidence, 'review.json'), JSON.stringify({ slug, purchaseId: row.purchase_id, winningTrace: ids[0], checkoutTrace: ids[1] }, null, 2));
    await page.screenshot({ path: join(evidence, 'winner-paid.png') });
    await seller.screenshot({ path: join(evidence, 'seller-paid.png') });
    const jaeger = await sellerContext.newPage();
    await jaeger.goto(`http://localhost:16688/trace/${ids[0]}`);
    await expect(jaeger.getByText('auction.close', { exact: true }).first()).toBeVisible();
    await jaeger.screenshot({ path: join(evidence, 'jaeger-winning-trace.png'), fullPage: true });
    console.log(`GOLDEN TRACE PASS: ${evidence}`);
  } finally {
    await sellerContext.close();
    // Retain this explicitly named review auction and exported evidence for manual inspection.
    await pool.end();
  }
});
