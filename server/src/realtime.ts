import { span, currentCarrier } from '@auction/telemetry';
import { paymentChannel } from './paymentDelivery.js';
import { Server } from 'socket.io';
import { createClient } from 'redis';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';

const changeSchema = z.object({ auctionSlug: z.string().min(1).max(160) }).strict();
const channel = 'auction-part-8:auction-changed';
const notificationsChannel = 'auction-part-8:notifications';
const notificationSignalSchema = z.object({ notificationId: z.string().uuid(), recipientId: z.string().min(1).max(80), traceContext: z.unknown().optional() }).strict();
const userSchema = z.object({ userId: z.string().min(1).max(80) }).strict();
const notificationRoom = (userId: string) => `user:${userId}`;
const room = (slug: string) => `auction:${slug}`;

export interface Realtime {
  start(): Promise<void>;
  close(): Promise<void>;
  healthy(): boolean;
  publish(slug: string): Promise<void>;
}

export function createRealtime(app: FastifyInstance, pool: pg.Pool,
  url = process.env.REDIS_URL ?? 'redis://localhost:56388'): Realtime {
  const origins = (process.env.WEB_ORIGINS ?? 'http://localhost:5108,http://127.0.0.1:5108').split(',');
  const io = new Server(app.server, {
    serveClient: false,
    cors: { origin: origins },
    allowRequest: (request, done) => done(null, !request.headers.origin || origins.includes(request.headers.origin)),
  });
  const publisher = createClient({ url, disableOfflineQueue: true, socket: { connectTimeout: 1500 } });
  const subscriber = publisher.duplicate();
  let subscribed = false;
  let stopping = false;
  let deliveryFailed = false;
  let probe: ReturnType<typeof setInterval> | undefined;
  let probing = false;
  const healthy = () => publisher.isReady && subscriber.isReady && subscribed && !deliveryFailed && !stopping;
  function interrupt() {
    // Close the transport, rather than explicitly disconnecting the namespace:
    // Socket.IO clients then reconnect and rejoin before fetching missed state.
    for (const socket of io.sockets.sockets.values()) socket.conn.close();
  }
  for (const client of [publisher, subscriber]) {
    client.on('error', (error) => { app.log.warn({ err: error }, 'Redis realtime unavailable'); interrupt(); });
    client.on('reconnecting', interrupt);
  }
  io.use((_socket, next) => next(healthy() ? undefined : new Error('Live updates unavailable')));
  io.on('connection', (socket) => {
    let watchGeneration = 0;
    let recipientId: string | undefined;
    let paymentGeneration = 0;
    socket.on('payment:watch', async (payload: unknown, acknowledge: unknown) => {
      const generation = ++paymentGeneration;
      if (typeof acknowledge !== 'function') return;
      const parsed = z.object({ auctionSlug: z.string().min(1).max(160), userId: z.string().min(1).max(80) }).strict().safeParse(payload);
      if (!parsed.success || !healthy()) return acknowledge({ ok: false });
      try {
        const { auctionSlug, userId } = parsed.data;
        const allowed = await pool.query(
          'SELECT 1 FROM auction_closes c JOIN auctions a ON a.slug=c.auction_slug WHERE c.auction_slug=$1 AND c.winner_id IS NOT NULL AND ($2=c.winner_id OR $2=a.seller_id)', [auctionSlug, userId]);
        if (!allowed.rowCount || !socket.connected || generation !== paymentGeneration) return acknowledge({ ok: false });
        for (const previous of socket.rooms) if (previous.startsWith('payment:')) await socket.leave(previous);
        const watchedRoom = `payment:${userId}:${auctionSlug}`;
        await socket.join(watchedRoom);
        if (generation !== paymentGeneration) { await socket.leave(watchedRoom); return acknowledge({ ok: false }); }
        acknowledge({ ok: true });
      } catch (err) { app.log.warn({ err }, 'payment subscription failed'); acknowledge({ ok: false }); }
    });
    socket.on('auction:watch', async (payload: unknown, acknowledge: unknown) => {
      const generation = ++watchGeneration;
      if (typeof acknowledge !== 'function') return;
      const parsed = changeSchema.safeParse(payload);
      if (!parsed.success || !healthy()) return acknowledge({ ok: false });
      try {
        const exists = await pool.query('SELECT 1 FROM auctions WHERE slug=$1', [parsed.data.auctionSlug]);
        if (!exists.rowCount || !socket.connected || !healthy() || generation !== watchGeneration) return acknowledge({ ok: false });
        // One watched auction per connection bounds room membership.
        for (const previous of socket.rooms) if (previous !== socket.id) await socket.leave(previous);
        await socket.join(room(parsed.data.auctionSlug));
        if (generation !== watchGeneration) { await socket.leave(room(parsed.data.auctionSlug)); return acknowledge({ ok: false }); }
        acknowledge({ ok: true });
      } catch (error) {
        app.log.warn({ err: error }, 'auction subscription failed');
        acknowledge({ ok: false });
      }
    });
    socket.on('notification:watch', async (payload: unknown, acknowledge: unknown) => {
      if (typeof acknowledge !== 'function') return;
      const parsed = userSchema.safeParse(payload);
      if (!parsed.success || !healthy()) return acknowledge({ ok: false });
      try {
        const exists = await pool.query('SELECT 1 FROM demo_users WHERE id=$1', [parsed.data.userId]);
        if (!exists.rowCount || !socket.connected || !healthy()) return acknowledge({ ok: false });
        if (recipientId) await socket.leave(notificationRoom(recipientId));
        recipientId = parsed.data.userId;
        await socket.join(notificationRoom(recipientId));
        const pending = await pool.query(`SELECT notification_id::text AS "notificationId", recipient_id AS "recipientId",
            recipient_role AS "recipientRole", trace_context AS "traceContext", payload, created_at AS "createdAt"
          FROM recipient_notifications WHERE recipient_id=$1 AND dismissed_at IS NULL
          ORDER BY created_at, notification_id`, [recipientId]);
        if (!socket.connected || !healthy()) return acknowledge({ ok: false });
        acknowledge({ ok: true, notifications: pending.rows });
      } catch (error) {
        app.log.warn({ err: error }, 'notification subscription failed');
        acknowledge({ ok: false });
      }
    });
    socket.on('notification:dismiss', async (payload: unknown, acknowledge: unknown) => {
      if (typeof acknowledge !== 'function' || !recipientId || !healthy()) return;
      const parsed = z.object({ notificationId: z.string().uuid() }).strict().safeParse(payload);
      if (!parsed.success) return acknowledge({ ok: false });
      try {
        await pool.query(`UPDATE recipient_notifications SET dismissed_at=clock_timestamp()
          WHERE notification_id=$1 AND recipient_id=$2 AND dismissed_at IS NULL`, [parsed.data.notificationId, recipientId]);
        acknowledge({ ok: true });
      } catch (error) {
        app.log.warn({ err: error }, 'notification dismissal failed');
        acknowledge({ ok: false });
      }
    });
  });
  async function close() {
    stopping = true;
    clearInterval(probe);
    for (const client of [publisher, subscriber]) if (client.isOpen) client.destroy();
    await new Promise<void>((resolve) => io.close(() => resolve()));
  }
  return {
    healthy,
    async start() {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (async () => {
            await Promise.all([publisher.connect(), subscriber.connect()]);
            await subscriber.subscribe(channel, (message) => {
              let parsed;
              try { parsed = changeSchema.safeParse(JSON.parse(message)); } catch { return; }
              if (parsed.success) io.to(room(parsed.data.auctionSlug)).emit('auction:changed', parsed.data);
            });
            await subscriber.subscribe(notificationsChannel, async (message) => {
              let parsed;
              try { parsed = notificationSignalSchema.safeParse(JSON.parse(message)); } catch { return; }
              if (!parsed.success) return;
              try {
                const result = await pool.query(`SELECT notification_id::text AS "notificationId", recipient_id AS "recipientId",
                    recipient_role AS "recipientRole", payload, created_at AS "createdAt"
                  FROM recipient_notifications WHERE notification_id=$1 AND recipient_id=$2 AND dismissed_at IS NULL`,
                [parsed.data.notificationId, parsed.data.recipientId]);
                if (result.rows[0]) await span('notification.emit', { 'notification.id': parsed.data.notificationId, 'auction.id': result.rows[0].payload.auctionSlug, role: result.rows[0].recipientRole, outcome: 'emitted' }, async () => { io.to(notificationRoom(parsed.data.recipientId)).emit('notification:received', { ...result.rows[0], traceContext: currentCarrier() }); }, parsed.data.traceContext);
              } catch (error) { app.log.warn({ err: error }, 'notification signal lookup failed'); }
            });
            await subscriber.subscribe(paymentChannel, async (message) => {
              const schema = z.object({ eventId: z.string().uuid(), recipientId: z.string().min(1).max(80), traceContext: z.unknown().optional() }).strict();
              let parsed;
              try { parsed = schema.safeParse(JSON.parse(message)); } catch { return; }
              if (!parsed.success) return;
              try {
                const row = (await pool.query(`SELECT d.auction_slug FROM payment_deliveries d
                  JOIN purchases p ON p.auction_slug=d.auction_slug JOIN auctions a ON a.slug=p.auction_slug
                  WHERE d.event_id=$1 AND d.recipient_id=$2 AND p.paid_at IS NOT NULL
                    AND ($2=p.buyer_id OR $2=a.seller_id)`, [parsed.data.eventId, parsed.data.recipientId])).rows[0];
                if (row) await span('payment.emit', { 'event.id': parsed.data.eventId, 'auction.id': row.auction_slug, outcome: 'emitted' }, async () => { io.to(`payment:${parsed.data.recipientId}:${row.auction_slug}`).emit('payment:changed', { auctionSlug: row.auction_slug, traceContext: currentCarrier() }); }, parsed.data.traceContext);
              } catch (err) { app.log.warn({ err }, 'payment signal lookup failed'); }
            });
            subscribed = true;
            probe = setInterval(() => {
              if (probing || stopping) return;
              probing = true;
              void Promise.all([
                publisher.withCommandOptions({ timeout: 1500 }).ping(),
                subscriber.withCommandOptions({ timeout: 1500 }).ping(),
              ]).then(() => { deliveryFailed = false; }, () => { deliveryFailed = true; interrupt(); })
                .finally(() => { probing = false; });
            }, 2000);
            probe.unref();
          })(),
          new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('Redis startup timed out')), 4000); }),
        ]);
      } catch (error) { await close(); throw error; }
      finally { clearTimeout(timeout); }
    },
    async publish(slug) {
      if (!healthy()) throw new Error('Redis realtime unavailable');
      try {
        await publisher.withCommandOptions({ timeout: 1500 }).publish(channel, JSON.stringify(changeSchema.parse({ auctionSlug: slug })));
      } catch (error) {
        deliveryFailed = true;
        interrupt();
        throw error;
      }
    },
    close,
  };
}
