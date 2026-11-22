import { afterAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createServer, connect, type Socket as NetSocket } from 'node:net';
import { once } from 'node:events';
import pg from 'pg';
import { createClient } from 'redis';
import { io, type Socket } from 'socket.io-client';
import { buildApp } from './app.js';
import type { Realtime } from './realtime.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? process.env.DATABASE_URL! });
const slugs: string[] = [];
const socketEvent = (socket: Socket, event: string) => new Promise<unknown[]>((resolve) => socket.once(event, (...args: unknown[]) => resolve(args)));
async function fixture() {
  const slug = `realtime-test-${randomUUID()}`;
  slugs.push(slug);
  await pool.query(`INSERT INTO auctions (slug,title,description,category,condition,seller,seller_id,starting_price_minor,ends_at,art)
    VALUES ($1,'Realtime test','Test','Other','Used','Alex Morgan','alex-morgan',10000,now()+interval '1 day','chassis')`, [slug]);
  return slug;
}
afterAll(async () => {
  await pool.query('DELETE FROM bids WHERE auction_slug=ANY($1::text[])', [slugs]);
  await pool.query('DELETE FROM auctions WHERE slug=ANY($1::text[])', [slugs]);
  await pool.end();
});
const bid = (app: ReturnType<typeof buildApp>, slug: string, amountMinor = 10100, bidderId = 'jordan-lee') => app.inject({
  method: 'POST', url: `/api/auctions/${slug}/bids`, payload: { bidderId, amountMinor },
});
const fake = (publish: Realtime['publish']): Realtime => ({ start: async () => {}, close: async () => {}, healthy: () => true, publish });

it('publishes only after COMMIT is visible on another connection; rejects emit nothing', async () => {
  const slug = await fixture();
  const observed: number[] = [];
  const app = buildApp({ realtime: fake(async (changed) => {
    expect(changed).toBe(slug);
    observed.push((await pool.query('SELECT count(*)::int AS count FROM bids WHERE auction_slug=$1', [slug])).rows[0].count);
  }) });
  try {
    expect((await bid(app, slug, 10000)).statusCode).toBe(409);
    expect(observed).toEqual([]);
    expect((await bid(app, slug)).statusCode).toBe(201);
    expect(observed).toEqual([1]);
    expect((await bid(app, slug)).statusCode).toBe(409);
    expect((await bid(app, slug, 10200)).statusCode).toBe(409);
    expect(observed).toEqual([1]);
  } finally { await app.close(); }
});

it('keeps a committed bid accepted when publication fails, and never publishes on transaction error', async () => {
  const slug = await fixture();
  let calls = 0;
  const realtime = fake(async () => { calls++; throw new Error('injected publication failure'); });
  const app = buildApp({ realtime });
  const failing = buildApp({ realtime, clock: () => { throw new Error('injected transaction failure'); } });
  try {
    expect((await bid(failing, slug)).statusCode).toBe(500);
    expect(calls).toBe(0);
    expect((await bid(app, slug)).statusCode).toBe(201);
    expect(calls).toBe(1);
    expect((await pool.query('SELECT amount_minor FROM bids WHERE auction_slug=$1', [slug])).rows).toEqual([{ amount_minor: 10100 }]);
  } finally { await app.close(); await failing.close(); }
});

it('refuses readiness when Redis cannot be reached and closes failed startup resources', async () => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const app = buildApp({ redisUrl: `redis://127.0.0.1:${port}` });
  try { await expect(app.ready()).rejects.toThrow('Redis startup timed out'); }
  finally { await app.close(); }
}, 10000);

it('routes through Redis, isolates validated rooms, and recovers after a targeted Redis transport outage', async () => {
  // An isolated TCP proxy lets this test interrupt only its own Redis clients.
  const wires = new Set<NetSocket>();
  let available = true;
  const proxy = createServer((incoming) => {
        if (!available) { incoming.destroy(); return; }
        const redisUrl = new URL(
      process.env.REDIS_URL ?? 'redis://127.0.0.1:56398'
    );

    const upstream = connect(
      Number(redisUrl.port || 6379),
      redisUrl.hostname
    );
    for (const socket of [incoming, upstream]) {
      wires.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => { wires.delete(socket); incoming.destroy(); upstream.destroy(); });
    }
    incoming.pipe(upstream); upstream.pipe(incoming);
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const address = proxy.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  const app = buildApp({ redisUrl: `redis://127.0.0.1:${address.port}` });
  const redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:56388' });
  redis.on('error', () => {});
  const sockets: Socket[] = [];
  try {
    const slug = await fixture(), other = await fixture();
    const url = await app.listen({ port: 0, host: '127.0.0.1' });
    await redis.connect();
    async function watcher(auctionSlug: string) {
      const socket = io(url, { transports: ['websocket'], reconnectionDelay: 50, reconnectionDelayMax: 100 });
      sockets.push(socket);
      await socketEvent(socket, 'connect');
      expect(await socket.timeout(2000).emitWithAck('auction:watch', { auctionSlug })).toEqual({ ok: true });
      return socket;
    }
    const watched = await watcher(slug), isolated = await watcher(other);
    let unwanted = 0;
    isolated.on('auction:changed', () => { unwanted++; });
    expect(await isolated.timeout(2000).emitWithAck('auction:watch', { auctionSlug: '' })).toEqual({ ok: false });
    expect(await isolated.timeout(2000).emitWithAck('auction:watch', { auctionSlug: 'missing' })).toEqual({ ok: false });
    const notification = socketEvent(watched, 'auction:changed');
    await redis.publish('auction-part-8:auction-changed', JSON.stringify({ auctionSlug: slug }));
    expect((await notification)[0]).toEqual({ auctionSlug: slug });
    const accepted = socketEvent(watched, 'auction:changed');
    expect((await bid(app, slug)).statusCode).toBe(201);
    expect((await accepted)[0]).toEqual({ auctionSlug: slug });
    expect(unwanted).toBe(0);
    available = false;
    for (const socket of wires) socket.destroy();
    await expect.poll(async () => (await app.inject('/api/health')).statusCode).toBe(503);
    expect((await bid(app, slug, 10200, 'sam-rivera')).statusCode).toBe(201);
    available = true;
    await expect.poll(async () => (await app.inject('/api/health')).statusCode, { timeout: 8000 }).toBe(200);
    watched.connect();
    await expect.poll(() => watched.connected).toBe(true);
    expect(await watched.timeout(2000).emitWithAck('auction:watch', { auctionSlug: slug })).toEqual({ ok: true });
    expect((await app.inject(`/api/auctions/${slug}`)).json().currentPriceMinor).toBe(10200);
    const recovered = socketEvent(watched, 'auction:changed');
    expect((await bid(app, slug, 10300)).statusCode).toBe(201);
    expect((await recovered)[0]).toEqual({ auctionSlug: slug });
  } finally {
    sockets.forEach((socket) => socket.disconnect());
    if (redis.isOpen) redis.destroy();
    await app.close();
    for (const socket of wires) socket.destroy();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
}, 20000);
