import { expect, it } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import pg from 'pg';
import amqp, { type GetMessage } from 'amqplib';
import { createClient } from 'redis';
import { io, type Socket } from 'socket.io-client';
import { buildApp } from './app.js';
import { publishPendingOutbox } from './outbox.js';
import { RabbitOutboxPublisher, closeEventsExchange, notificationQueue } from './rabbitOutboxPublisher.js';
import { persistRecipientNotifications } from './notificationDelivery.js';

it('delivers paid signals only to authorized roles through RabbitMQ redelivery and Redis, then recovers on reconnect', async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? process.env.DATABASE_URL! });
  const slug = `payment-live-${randomUUID()}`, purchaseId = randomUUID();
  const app = buildApp();
  const rabbitUrl = process.env.RABBITMQ_URL!;
  const publisher = new RabbitOutboxPublisher(rabbitUrl);
  const connection = await amqp.connect(rabbitUrl);
  const channel = await connection.createChannel();
  const redis = createClient({ url: process.env.REDIS_URL! });
  redis.on('error', () => {});
  const sockets: Socket[] = [];
  try {
    await redis.connect();
    await channel.assertExchange(closeEventsExchange, 'topic', { durable: true });
    const queue = (await channel.assertQueue('', { exclusive: true })).queue;
    await channel.bindQueue(queue, closeEventsExchange, 'payment.paid');
    await pool.query(`INSERT INTO auctions (slug,title,description,category,condition,seller,seller_id,starting_price_minor,ends_at,art)
      VALUES ($1,'Payment realtime','Test','Other','Used','Alex Morgan','alex-morgan',10000,now()+interval '1 day','chassis')`, [slug]);
    const bid = (await pool.query(`INSERT INTO bids (auction_slug,bidder_id,amount_minor,accepted_at) VALUES ($1,'jordan-lee',12500,now()) RETURNING id`, [slug])).rows[0].id;
    await pool.query(`INSERT INTO auction_closes (auction_slug,closed_at,winning_bid_id,winner_id,winning_amount_minor) VALUES ($1,now(),$2,'jordan-lee',12500)`, [slug, bid]);
    await pool.query(`INSERT INTO purchases (id,auction_slug,buyer_id,amount_minor,title,success_url,cancel_url,session_id) VALUES ($1,$2,'jordan-lee',12500,'Test','http://localhost:5108','http://localhost:5108','cs_test_realtime')`, [purchaseId, slug]);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address(); if (!address || typeof address === 'string') throw new Error('No API port');
    const watches: { ok: boolean }[] = [], seen: unknown[][] = [[], [], []];
    for (const [index, userId] of ['alex-morgan', 'jordan-lee', 'sam-rivera'].entries()) {
      const socket = io(`http://127.0.0.1:${address.port}`, { transports: ['websocket'], autoConnect: false }); sockets.push(socket);
      socket.on('payment:changed', (event) => seen[index].push(event));
      await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect(); });
      watches.push(await socket.timeout(2000).emitWithAck('payment:watch', { auctionSlug: slug, userId }));
    }
    expect(watches.map((watch) => watch.ok)).toEqual([true, true, false]);
    // The outsider can watch public bidding, but still receives no payment signal.
    await sockets[2].timeout(2000).emitWithAck('auction:watch', { auctionSlug: slug });
    sockets[0].disconnect();
    const body = JSON.stringify({ eventId: randomUUID(), eventType: 'checkout.session.completed', occurredAt: new Date().toISOString(),
      data: { object: { id: 'cs_test_realtime', object: 'checkout.session', status: 'complete', payment_status: 'paid', client_reference_id: purchaseId, amount_total: 12500, currency: 'usd' } } });
    const response = await app.inject({ method: 'POST', url: '/api/webhooks/stripe', headers: { 'content-type': 'application/json', 'x-stripe-signature': createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET!).update(body).digest('hex') }, payload: body });
    expect(response.statusCode).toBe(200);
    await publishPendingOutbox(pool, publisher);
    const first = await channel.get(queue, { noAck: false }); if (!first) throw new Error('Payment event not published');
    const event: unknown = JSON.parse(first.content.toString());
    await persistRecipientNotifications(pool, redis, event);
    channel.nack(first, false, true);
    let second = await channel.get(queue, { noAck: false });
    await expect.poll(async () => { if (!second) second = await channel.get(queue, { noAck: false }); return !!second; }).toBe(true);
    if (!second) throw new Error('No redelivery');
    expect(second.fields.redelivered).toBe(true);
    await persistRecipientNotifications(pool, redis, JSON.parse(second.content.toString())); channel.ack(second);
    await expect.poll(() => seen[1].length).toBeGreaterThan(0);
    expect(seen[2]).toEqual([]);
    expect((await pool.query('SELECT recipient_id FROM payment_deliveries WHERE auction_slug=$1 ORDER BY recipient_id', [slug])).rows).toEqual([{ recipient_id: 'alex-morgan' }, { recipient_id: 'jordan-lee' }]);
    await new Promise<void>((resolve) => { sockets[0].once('connect', resolve); sockets[0].connect(); });
    expect((await sockets[0].timeout(2000).emitWithAck('payment:watch', { auctionSlug: slug, userId: 'alex-morgan' })).ok).toBe(true);
    expect((await app.inject(`/api/auctions/${slug}/checkout?userId=alex-morgan`)).json()).toEqual({ role: 'seller', status: 'paid', amountMinor: 12500 });
    await persistRecipientNotifications(pool, redis, event);
    await expect.poll(() => seen[0].length).toBeGreaterThan(0);
    expect(seen.flat().every((signal) => JSON.stringify(signal) === JSON.stringify({ auctionSlug: slug }))).toBe(true);
  } finally {
    for (const socket of sockets) socket.close();
    await app.close(); await publisher.close();
    const retained: GetMessage[] = [];
    for (;;) {
      const message = await channel.get(notificationQueue, { noAck: false });
      if (!message) break;
      if (JSON.parse(message.content.toString()).auctionSlug === slug) channel.ack(message);
      else retained.push(message);
    }
    for (const message of retained) channel.nack(message, false, true);
    await connection.close();
    if (redis.isOpen) await redis.quit();
    await pool.query('DELETE FROM payment_deliveries WHERE auction_slug=$1', [slug]);
    await pool.query('DELETE FROM payment_webhook_receipts WHERE purchase_id=$1', [purchaseId]);
    await pool.query('DELETE FROM purchases WHERE auction_slug=$1', [slug]);
    await pool.query('DELETE FROM outbox_events WHERE auction_slug=$1', [slug]);
    await pool.query('DELETE FROM auction_closes WHERE auction_slug=$1', [slug]);
    await pool.query('DELETE FROM bids WHERE auction_slug=$1', [slug]);
    await pool.query('DELETE FROM auctions WHERE slug=$1', [slug]); await pool.end();
  }
}, 15000);
