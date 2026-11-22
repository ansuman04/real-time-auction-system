import { afterAll, beforeAll, expect, it } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import pg from 'pg';
import { registerCheckout } from './checkout.js';
import { buildStripeApp } from '../../stripe-service/src/app.js';
import { persistRecipientNotifications } from './notificationDelivery.js';
import { paymentChannel } from './paymentDelivery.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? process.env.DATABASE_URL! });
const app = Fastify();
const slugs: string[] = [];
let delivery = true;
const originalFetch = globalThis.fetch;
let stripe: ReturnType<typeof buildStripeApp>;
beforeAll(async () => {
  stripe = buildStripeApp({ logger: false, retryMs: 25, deliverWebhook: async (body, signature) => {
    if (!delivery) return false;
    return (await webhook(body, signature)).statusCode === 200;
  } });
  await stripe.ready();
  process.env.STRIPE_URL = 'http://127.0.0.1:7108';
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith('http://127.0.0.1:7108/')) {
      const response = await stripe.inject({ method: init?.method === 'POST' ? 'POST' : 'GET', url: new URL(String(input)).pathname,
        headers: { 'content-type': 'application/json' }, ...(init?.body ? { payload: String(init.body) } : {}) });
      return new Response(response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
    }
    return originalFetch(input, init);
  };
  registerCheckout(app, pool);
  await app.ready();
});

async function fixture(withWinner = true, closed = true) {
  const slug = `checkout-test-${randomUUID()}`; slugs.push(slug);
  await pool.query(`INSERT INTO auctions (slug,title,description,category,condition,seller,seller_id,starting_price_minor,ends_at,art)
    VALUES ($1,'Checkout test','Test','Other','Used','Alex Morgan','alex-morgan',10000,now()+interval '1 day','chassis')`, [slug]);
  const bid = withWinner ? (await pool.query(`INSERT INTO bids (auction_slug,bidder_id,amount_minor,accepted_at)
    VALUES ($1,'jordan-lee',12500,now()-interval '2 minutes') RETURNING id`, [slug])).rows[0].id : null;
  if (closed) await pool.query(`INSERT INTO auction_closes (auction_slug,closed_at,winning_bid_id,winner_id,winning_amount_minor)
    VALUES ($1,now(),$2,$3,$4)`, [slug, bid, withWinner ? 'jordan-lee' : null, withWinner ? 12500 : null]);
  return slug;
}
const start = (slug: string, buyerId = 'jordan-lee', extra = {}) => app.inject({ method: 'POST', url: `/api/auctions/${slug}/checkout`, payload: { buyerId, ...extra } });
const status = (slug: string) => app.inject(`/api/auctions/${slug}/checkout?buyerId=jordan-lee`);
function webhook(body: string, signature = createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET!).update(body).digest('hex')) {
  return app.inject({ method: 'POST', url: '/api/webhooks/stripe', headers: { 'content-type': 'application/json', 'x-stripe-signature': signature }, payload: body });
}
async function eventFor(slug: string) {
  const p = (await pool.query('SELECT * FROM purchases WHERE auction_slug=$1', [slug])).rows[0];
  return { eventId: randomUUID(), eventType: 'checkout.session.completed', occurredAt: new Date().toISOString(), data: { object: {
    id: p.session_id, object: 'checkout.session', status: 'complete', payment_status: 'paid', client_reference_id: p.id, amount_total: p.amount_minor, currency: 'usd',
  } } };
}

it('authorizes only the recorded winner and rejects client-owned price fields', async () => {
  const slug = await fixture();
  for (const user of ['alex-morgan', 'sam-rivera', 'unknown']) expect((await start(slug, user)).statusCode).toBe(403);
  expect((await start(await fixture(false))).statusCode).toBe(403);
  expect((await start(await fixture(true, false))).statusCode).toBe(403);
  expect((await start(slug, 'jordan-lee', { amountMinor: 1 })).statusCode).toBe(400);
  expect((await start(slug)).statusCode).toBe(200);
  expect((await pool.query('SELECT amount_minor FROM purchases WHERE auction_slug=$1', [slug])).rows[0].amount_minor).toBe(12500);
  const session = (await pool.query('SELECT session_id FROM purchases WHERE auction_slug=$1', [slug])).rows[0].session_id;
  expect((await stripe.inject(`/checkout/${session}`)).body).toContain('$125.00');
});

it('reuses one purchase and session under concurrent repeated clicks', async () => {
  const slug = await fixture();
  const responses = await Promise.all(Array.from({ length: 8 }, () => start(slug)));
  expect(responses.every((r) => r.statusCode === 200)).toBe(true);
  expect(new Set(responses.map((r) => r.json().url)).size).toBe(1);
  expect((await pool.query('SELECT id FROM purchases WHERE auction_slug=$1', [slug])).rowCount).toBe(1);
});

it('recovers an ambiguous creation response using the same durable purchase and provider session', async () => {
  const slug = await fixture();
  const adapter = globalThis.fetch;
  let lostUrl = '';
  globalThis.fetch = async (input, init) => {
    const result = await adapter(input, init);
    lostUrl = (await result.clone().json()).url;
    throw new Error('Response lost after provider persisted session');
  };
  try { expect((await start(slug)).statusCode).toBe(503); }
  finally { globalThis.fetch = adapter; }
  const purchase = (await pool.query('SELECT id,session_id FROM purchases WHERE auction_slug=$1', [slug])).rows[0];
  expect(purchase.session_id).toBeNull();
  expect((await start(slug)).json().url).toBe(lostUrl);
  expect((await pool.query('SELECT id FROM purchases WHERE auction_slug=$1', [slug])).rows[0].id).toBe(purchase.id);
});

it('requires a valid raw-body signature and matching payment terms', async () => {
  const slug = await fixture(); await start(slug);
  const event = await eventFor(slug), raw = JSON.stringify(event);
  expect((await app.inject({ method: 'POST', url: '/api/webhooks/stripe', headers: { 'content-type': 'application/json' }, payload: raw })).statusCode).toBe(400);
  expect((await webhook(raw, '0'.repeat(64))).statusCode).toBe(400);
  expect((await webhook(raw, 'malformed')).statusCode).toBe(400);
  const signature = createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET!).update(raw).digest('hex');
  expect((await webhook(raw + ' ', signature)).statusCode).toBe(400);
  expect((await webhook('{')).statusCode).toBe(400);
  for (const patch of [{ id: 'cs_test_wrong' }, { client_reference_id: randomUUID() }, { amount_total: 1 }, { currency: 'eur' }, { payment_status: 'unpaid' }]) {
    const changed = structuredClone(event); Object.assign(changed.data.object, patch);
    expect((await webhook(JSON.stringify(changed))).statusCode).toBeGreaterThanOrEqual(400);
  }
  expect((await status(slug)).json().status).toBe('pending');
  expect((await app.inject(`/api/auctions/${slug}/checkout?buyerId=jordan-lee&checkout=success`)).statusCode).toBe(400);
});

it('applies concurrent duplicates once, rejects conflicting replays, and never regresses paid', async () => {
  const slug = await fixture(); await start(slug);
  const event = await eventFor(slug), raw = JSON.stringify(event);
  const responses = await Promise.all(Array.from({ length: 6 }, () => webhook(raw)));
  expect(responses.every((r) => r.statusCode === 200)).toBe(true);
  const before = (await pool.query('SELECT paid_at FROM purchases WHERE auction_slug=$1', [slug])).rows[0].paid_at;
  expect((await pool.query('SELECT * FROM payment_webhook_receipts WHERE event_id=$1', [event.eventId])).rowCount).toBe(1);
  event.occurredAt = '2020-01-01T00:00:00.000Z';
  expect((await webhook(JSON.stringify(event))).statusCode).toBe(409);
  expect((await start(slug)).json()).toEqual({ status: 'paid' });
  expect((await status(slug)).json().status).toBe('paid');
  expect((await pool.query('SELECT paid_at FROM purchases WHERE auction_slug=$1', [slug])).rows[0].paid_at).toEqual(before);
});

it('keeps decline/cancel resumable and automatically confirms after callback outage', async () => {
  const slug = await fixture(); const first = (await start(slug)).json();
  const sessionId = first.url.split('/').pop();
  const attempt = (cardNumber: string) => stripe.inject({ method: 'POST', url: `/v1/checkout/sessions/${sessionId}/attempt`, payload: { cardNumber, expiry: '12 / 30', cvc: '123' } });
  expect((await attempt('4000000000000002')).statusCode).toBe(402);
  expect((await status(slug)).json().status).toBe('pending');
  expect((await stripe.inject(`/checkout/${sessionId}`)).body).toContain('checkout=canceled');
  expect((await start(slug)).json().url).toBe(first.url);
  delivery = false;
  expect((await attempt('4242424242424242')).json().confirmation_pending).toBe(true);
  expect((await status(slug)).json().status).toBe('pending');
  expect((await stripe.inject(`/checkout/${sessionId}`)).body).toContain('Payment received');
  delivery = true;
  await expect.poll(async () => (await status(slug)).json().status).toBe('paid');
  expect((await attempt('4242424242424242')).statusCode).toBe(200);
  const p = (await pool.query('SELECT id FROM purchases WHERE auction_slug=$1', [slug])).rows[0];
  expect((await pool.query('SELECT * FROM payment_webhook_receipts WHERE purchase_id=$1', [p.id])).rowCount).toBe(1);
});

it('limits status to seller and winner without disclosing checkout details', async () => {
  const slug = await fixture();
  const seller = () => app.inject(`/api/auctions/${slug}/checkout?userId=alex-morgan`);
  expect((await seller()).json()).toEqual({ role: 'seller', status: 'unpaid', amountMinor: 12500 });
  await start(slug);
  expect((await seller()).json()).toEqual({ role: 'seller', status: 'unpaid', amountMinor: 12500 });
  for (const id of ['sam-rivera', 'unknown']) expect((await app.inject(`/api/auctions/${slug}/checkout?userId=${id}`)).statusCode).toBe(403);
  await webhook(JSON.stringify(await eventFor(slug)));
  expect((await seller()).json()).toEqual({ role: 'seller', status: 'paid', amountMinor: 12500 });
  expect((await start(slug, 'alex-morgan')).statusCode).toBe(403);
  expect(JSON.stringify((await app.inject(`/api/auctions/${slug}`)).json())).not.toContain('paid_at');
});

it('replaces a disappeared unpaid session on the same purchase and rejects the old hosted session', async () => {
  const slug = await fixture(); const first = (await start(slug)).json();
  const oldId = first.url.split('/').pop();
  const purchase = (await pool.query('SELECT id FROM purchases WHERE auction_slug=$1', [slug])).rows[0].id;
  expect((await stripe.inject({ method: 'POST', url: `/v1/checkout/sessions/${oldId}/expire` })).statusCode).toBe(200);
  const repeated = await Promise.all([start(slug), start(slug), start(slug)]);
  expect(new Set(repeated.map((r) => r.json().url)).size).toBe(1);
  expect(repeated[0].json().url).not.toBe(first.url);
  expect((await stripe.inject(`/checkout/${oldId}`)).statusCode).toBe(404);
  expect((await pool.query('SELECT id FROM purchases WHERE auction_slug=$1', [slug])).rows[0].id).toBe(purchase);
  const id = repeated[0].json().url.split('/').pop();
  await stripe.inject({ method: 'POST', url: `/v1/checkout/sessions/${id}/attempt`, payload: { cardNumber: '4242424242424242', expiry: '12 / 30', cvc: '123' } });
  expect((await status(slug)).json().status).toBe('paid');
  expect((await stripe.inject({ method: 'POST', url: `/v1/checkout/sessions/${id}/expire` })).statusCode).toBe(409);
});

it('does not replace paid or unknown sessions when confirmation is missing', async () => {
  const slug = await fixture(); const first = (await start(slug)).json();
  const id = first.url.split('/').pop();
  delivery = false;
  try {
    await stripe.inject({ method: 'POST', url: `/v1/checkout/sessions/${id}/attempt`, payload: { cardNumber: '4242424242424242', expiry: '12 / 30', cvc: '123' } });
    expect((await start(slug)).json()).toEqual({ status: 'pending', confirmationPending: true });
    const adapter = globalThis.fetch;
    globalThis.fetch = async (input, init) => init?.method !== 'POST' ? new Response('{}', { status: 404 }) : adapter(input, init);
    try { expect((await start(slug)).json()).toEqual({ status: 'pending', confirmationPending: true }); }
    finally { globalThis.fetch = adapter; }
    expect((await pool.query('SELECT session_id FROM purchases WHERE auction_slug=$1', [slug])).rows[0].session_id).toBe(id);
    const unknown = await fixture(); await start(unknown);
    const fakeId = 'cs_test_deadbeef';
    await pool.query('UPDATE purchases SET session_id=$1,id=$3 WHERE auction_slug=$2', [fakeId, unknown, randomUUID()]);
    expect((await start(unknown)).statusCode).toBe(503);
  } finally { delivery = true; }
  await expect.poll(async () => (await status(slug)).json().status).toBe('paid');
});

it('creates one paid outbox event and recovers idempotent seller/winner delivery after Redis failure', async () => {
  const slug = await fixture(); await start(slug);
  const event = await eventFor(slug);
  await Promise.all([webhook(JSON.stringify(event)), webhook(JSON.stringify(event))]);
  await webhook(JSON.stringify({ ...event, eventId: randomUUID() }));
  const rows = await pool.query(`SELECT event_id AS "eventId",event_type AS "eventType",auction_slug AS "auctionSlug",payload
    FROM outbox_events WHERE auction_slug=$1 AND event_type='payment.paid'`, [slug]);
  expect(rows.rowCount).toBe(1);
  await pool.query('UPDATE outbox_events SET published_at=clock_timestamp() WHERE event_id=$1', [rows.rows[0].eventId]);
  await expect(persistRecipientNotifications(pool, { publish: async () => { throw new Error('Redis down'); } }, rows.rows[0])).rejects.toThrow('Redis down');
  const signals: { channel: string; body: { recipientId: string } }[] = [];
  const publisher = { publish: async (channel: string, message: string) => { signals.push({ channel, body: JSON.parse(message) }); } };
  await persistRecipientNotifications(pool, publisher, rows.rows[0]);
  await persistRecipientNotifications(pool, publisher, rows.rows[0]);
  expect((await pool.query('SELECT recipient_id FROM payment_deliveries WHERE event_id=$1 ORDER BY recipient_id', [rows.rows[0].eventId])).rows).toEqual([{ recipient_id: 'alex-morgan' }, { recipient_id: 'jordan-lee' }]);
  expect(signals.every((signal) => signal.channel === paymentChannel && ['alex-morgan', 'jordan-lee'].includes(signal.body.recipientId))).toBe(true);
});

afterAll(async () => {
  globalThis.fetch = originalFetch; delete process.env.STRIPE_URL;
  await stripe?.close(); await app.close();
  await pool.query('DELETE FROM payment_webhook_receipts WHERE purchase_id IN (SELECT id FROM purchases WHERE auction_slug=ANY($1))', [slugs]);
  await pool.query('DELETE FROM payment_deliveries WHERE auction_slug=ANY($1)', [slugs]);
  await pool.query('DELETE FROM outbox_events WHERE auction_slug=ANY($1)', [slugs]);
  await pool.query('DELETE FROM purchases WHERE auction_slug=ANY($1)', [slugs]);
  await pool.query('DELETE FROM auction_closes WHERE auction_slug=ANY($1)', [slugs]);
  await pool.query('DELETE FROM bids WHERE auction_slug=ANY($1)', [slugs]);
  await pool.query('DELETE FROM auctions WHERE slug=ANY($1)', [slugs]);
  await pool.end();
});
