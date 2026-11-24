import { afterAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace';
import { carrier, currentCarrier, span, traceHeaders, safeAttributes } from '@auction/telemetry';
import { tracedPool } from '@auction/telemetry/postgres';
import { buildApp } from './app.js';
import { closeDueAuctions } from './closing.js';
import { publishPendingOutbox } from './outbox.js';
import { persistRecipientNotifications } from './notificationDelivery.js';
import { RabbitOutboxPublisher, closeEventsExchange, notificationQueue } from './rabbitOutboxPublisher.js';
import amqp from 'amqplib';
import { buildStripeApp } from '../../stripe-service/src/app.js';
import { postgresSessionStore } from '../../stripe-service/src/store.js';

const exporter = new InMemorySpanExporter();
const sdk = new NodeSDK({
  autoDetectResources: false,
  spanProcessors: [new SimpleSpanProcessor({ exporter })],
});
sdk.start();
const pool = tracedPool({ connectionString: process.env.DATABASE_URL ?? process.env.DATABASE_URL! });
afterAll(async () => { await pool.end(); await sdk.shutdown(); });

it('validates optional carriers and excludes forbidden telemetry attributes', () => {
  for (const value of [null, {}, { traceparent: 'bad' }, { version: 2, traceparent: '00-' + '1'.repeat(32) + '-' + '2'.repeat(16) + '-01' }, { traceparent: '00-' + '0'.repeat(32) + '-' + '2'.repeat(16) + '-01' }]) expect(carrier(value)).toBeUndefined();
  expect(safeAttributes({ 'auction.id': 'safe-id', name: 'Do not export', handle: 'private', 'db.statement': 'SELECT secret', payload: 'raw', 'amount.minor': 12500, role: 'winner' })).toEqual({ 'auction.id': 'safe-id', 'amount.minor': 12500, role: 'winner' });
});

it('isolates concurrent auctions and tolerates missing or malformed durable context and no-bid outcomes', async () => {
  const slugs = [randomUUID(), randomUUID(), randomUUID()];
  const app = buildApp({ realtime: { start: async () => {}, close: async () => {}, healthy: () => true, publish: async () => {} } });
  try {
    for (const slug of slugs) await pool.query(`INSERT INTO auctions (slug,title,description,category,condition,seller,seller_id,starting_price_minor,ends_at,art)
      VALUES ($1,'Context isolation','Test','Other','Used','Alex Morgan','alex-morgan',10000,now()+interval '1 day','chassis')`, [slug]);
    const results = await Promise.all(slugs.slice(0, 2).map(slug => app.inject({ method: 'POST', url: `/api/auctions/${slug}/bids`, headers: { traceparent: 'malformed' }, payload: { bidderId: 'jordan-lee', amountMinor: 10100 } })));
    expect(results.map(r => r.statusCode)).toEqual([201, 201]);
    const contexts = (await pool.query('SELECT trace_context FROM bids WHERE auction_slug=ANY($1)', [slugs])).rows.map(r => carrier(r.trace_context)!.traceparent.split('-')[1]);
    expect(new Set(contexts).size).toBe(2);
    await pool.query(`UPDATE bids SET trace_context='{"version":99,"traceparent":"invalid"}' WHERE auction_slug=$1`, [slugs[0]]);
    await pool.query('UPDATE bids SET trace_context=NULL WHERE auction_slug=$1', [slugs[1]]);
    await pool.query("UPDATE auctions SET ends_at=now()-interval '1 second' WHERE slug=ANY($1)", [slugs]);
    expect(await closeDueAuctions(pool)).toBe(3);
    const rows = (await pool.query('SELECT * FROM auction_closes WHERE auction_slug=ANY($1)', [slugs])).rows;
    expect(rows.every(r => carrier(r.trace_context))).toBe(true);
    expect(rows.find(r => r.auction_slug === slugs[2]).winning_bid_id).toBeNull();
  } finally {
    await app.close();
    for (const table of ['outbox_events','auction_closes','bids','auctions']) await pool.query(`DELETE FROM ${table} WHERE ${table === 'auctions' ? 'slug' : 'auction_slug'}=ANY($1)`, [slugs]);
  }
});

it('keeps the winning journey through durable records, RabbitMQ, mock restart and webhook recovery without leaking data', async () => {
  const slug = `trace-${randomUUID()}`;
  const inert = { start: async () => {}, close: async () => {}, healthy: () => true, publish: async () => {} };
  let app: ReturnType<typeof buildApp> | undefined;
  let mock: ReturnType<typeof buildStripeApp> | undefined;
  const publisher = new RabbitOutboxPublisher(process.env.RABBITMQ_URL!);
  const connection = await amqp.connect(process.env.RABBITMQ_URL!);
  const channel = await connection.createChannel();
  let acceptWebhook = false;
  let purchaseId: string | undefined;
  try {
    await channel.assertExchange(closeEventsExchange, 'topic', { durable: true });
    const queue = (await channel.assertQueue('', { exclusive: true })).queue;
    await channel.bindQueue(queue, closeEventsExchange, 'auction.closed');
    await pool.query(`INSERT INTO auctions (slug,title,description,category,condition,seller,seller_id,starting_price_minor,ends_at,art)
      VALUES ($1,'Private title','Private description','Other','Used','Alex Morgan','alex-morgan',10000,now()+interval '1 day','chassis')`, [slug]);
    const deliver = async (body: string, signature: string) => acceptWebhook && (await app!.inject({ method: 'POST', url: '/api/webhooks/stripe', headers: { 'content-type': 'application/json', 'x-stripe-signature': signature, ...traceHeaders() }, payload: body })).statusCode === 200;
    mock = buildStripeApp({ logger: false, store: postgresSessionStore(), retryMs: 60_000, deliverWebhook: deliver });
    await mock.listen({ host: '127.0.0.1', port: 0 });
    const address = mock.server.address(); if (!address || typeof address === 'string') throw new Error('No mock port');
    process.env.STRIPE_URL = `http://127.0.0.1:${address.port}`;
    // Keep public-session URL validation unchanged.
    await mock.close();
    mock = buildStripeApp({ logger: false, store: postgresSessionStore(), baseUrl: process.env.STRIPE_URL, retryMs: 60_000, deliverWebhook: deliver });
    await mock.listen({ host: '127.0.0.1', port: address.port });
    app = buildApp({ realtime: inert });
    for (const [bidderId, amountMinor] of [['sam-rivera', 10100], ['jordan-lee', 10200]] as const) {
      await span('test.browser.bid', { 'auction.id': slug }, async () => {
        expect((await app!.inject({ method: 'POST', url: `/api/auctions/${slug}/bids`, headers: traceHeaders(), payload: { bidderId, amountMinor } })).statusCode).toBe(201);
      });
    }
    const bids = (await pool.query('SELECT trace_context FROM bids WHERE auction_slug=$1 ORDER BY amount_minor', [slug])).rows;
    const losing = carrier(bids[0].trace_context)!, winning = carrier(bids[1].trace_context)!;
    expect(winning).toBeDefined(); expect(winning.traceparent).not.toBe(losing.traceparent);
    await pool.query("UPDATE auctions SET ends_at=now()-interval '1 second' WHERE slug=$1", [slug]);
    await closeDueAuctions(pool);
    const close = (await pool.query('SELECT trace_context FROM auction_closes WHERE auction_slug=$1', [slug])).rows[0];
    expect(carrier(close.trace_context)?.traceparent.split('-')[1]).toBe(winning.traceparent.split('-')[1]);
    const signals: string[] = [];
    await publishPendingOutbox(pool, publisher);
    let message = await channel.get(queue);
    while (message && JSON.parse(message.content.toString()).auctionSlug !== slug) { channel.ack(message); message = await channel.get(queue); }
    if (!message) throw new Error('Missing RabbitMQ message');
    expect(carrier(message.properties.headers)?.traceparent.split('-')[1]).toBe(winning.traceparent.split('-')[1]);
    const event = JSON.parse(message.content.toString());
    await span('messaging.process', { 'event.id': event.eventId }, () => persistRecipientNotifications(pool, { publish: async (_channel, body) => { signals.push(body); } }, event), message.properties.headers);
    channel.ack(message);
    expect(signals).toHaveLength(2);
    expect(carrier(JSON.parse(signals[0]).traceContext)).toBeDefined();
    const checkout = await app.inject({ method: 'POST', url: `/api/auctions/${slug}/checkout`, payload: { buyerId: 'jordan-lee' } });
    expect(checkout.statusCode).toBe(200);
    const purchase = (await pool.query('SELECT * FROM purchases WHERE auction_slug=$1', [slug])).rows[0];
    purchaseId = purchase.id;
    expect(carrier(purchase.trace_context)).toBeDefined();
    const attempt = { cardNumber: '4000000000000002', expiry: '12 / 30', cvc: '123' };
    expect((await mock.inject({ method: 'POST', url: `/v1/checkout/sessions/${purchase.session_id}/attempt`, payload: attempt })).statusCode).toBe(402);
    expect((await mock.inject({ method: 'POST', url: `/v1/checkout/sessions/${purchase.session_id}/attempt`, payload: { ...attempt, cardNumber: '4242424242424242' } })).statusCode).toBe(200);
    expect((await pool.query('SELECT paid_at FROM purchases WHERE id=$1', [purchase.id])).rows[0].paid_at).toBeNull();
    await mock.close();
    acceptWebhook = true;
    mock = buildStripeApp({ logger: false, store: postgresSessionStore(), retryMs: 20, deliverWebhook: deliver });
    await mock.ready();
    await expect.poll(async () => (await pool.query('SELECT paid_at FROM purchases WHERE id=$1', [purchase.id])).rows[0].paid_at).not.toBeNull();
    const saved = (await pool.query('SELECT state FROM mock_stripe_sessions WHERE id=$1', [purchase.session_id])).rows[0].state;
    const replay = await app.inject({ method: 'POST', url: '/api/webhooks/stripe', headers: { 'content-type': 'application/json', 'x-stripe-signature': saved.completion.signature }, payload: saved.completion.body });
    expect(replay.statusCode).toBe(200);
    expect((await pool.query("SELECT count(*)::int AS n FROM outbox_events WHERE auction_slug=$1 AND event_type='payment.paid'", [slug])).rows[0].n).toBe(1);
    const spans = exporter.getFinishedSpans();
    expect(spans.some(s => s.name === 'postgresql.commit')).toBe(true);
    expect(spans.filter(s => s.name === 'purchase.paid')).toHaveLength(1);
    expect(spans.some(s => s.name === 'purchase.checkout' && s.links.some(l => l.context.traceId === winning.traceparent.split('-')[1]))).toBe(true);
    const decline = spans.find(s => s.attributes['mock_stripe.payment.outcome'] === 'declined');
    expect(decline?.status.code).toBe(0);
    const sends = spans.filter(s => s.name === 'mock-stripe.webhook.send');
    expect(sends.some(s => s.status.code === 2)).toBe(true);
    expect(sends.some(s => s.attributes.outcome === 'delivered')).toBe(true);
    const telemetry = JSON.stringify(spans.map(s => ({ name: s.name, attributes: s.attributes, events: s.events })));
    for (const forbidden of ['Alex Morgan', 'jordan-lee', 'Private title', '4242424242424242', '4000000000000002', 'SELECT ', 'INSERT ', 'db.statement', 'cardNumber', 'x-stripe-signature']) expect(telemetry).not.toContain(forbidden);
    await publishPendingOutbox(pool, { publishConfirmed: async () => {} });
    const before = exporter.getFinishedSpans().length;
    await closeDueAuctions(pool); await publishPendingOutbox(pool, { publishConfirmed: async () => {} });
    await app.inject('/api/health');
    expect(exporter.getFinishedSpans()).toHaveLength(before);
  } finally {
    delete process.env.STRIPE_URL;
    await mock?.close(); await app?.close(); await publisher.close();
    // The real publisher also routes a copy to the durable worker queue. Remove only this fixture.
    const retained: amqp.GetMessage[] = [];
    for (;;) {
      const queued = await channel.get(notificationQueue, { noAck: false });
      if (!queued) break;
      if (JSON.parse(queued.content.toString()).auctionSlug === slug) channel.ack(queued);
      else retained.push(queued);
    }
    for (const queued of retained) channel.nack(queued, false, true);
    await connection.close();
    if (purchaseId) { await pool.query('DELETE FROM mock_stripe_sessions WHERE purchase_id=$1', [purchaseId]); await pool.query('DELETE FROM mock_stripe_purchase_ledger WHERE purchase_id=$1', [purchaseId]); }
    for (const table of ['payment_deliveries','recipient_notifications','outbox_events','payment_webhook_receipts','purchases','auction_closes','bids','auctions']) await pool.query(`DELETE FROM ${table} WHERE ${table === 'payment_webhook_receipts' ? 'purchase_id=$1' : table === 'auctions' ? 'slug=$1' : 'auction_slug=$1'}`, [table === 'payment_webhook_receipts' ? purchaseId : slug]);
  }
}, 20_000);
