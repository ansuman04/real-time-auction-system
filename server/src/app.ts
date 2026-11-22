import { installHttpTracing } from './httpTracing.js';
import { tracedPool } from '@auction/telemetry/postgres';
import { registerCheckout } from './checkout.js';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { artByCategory, auctionResponse, createAuctionSchema, type AuctionRow } from './auctions.js';
import { z } from 'zod';
import { capabilities } from './capabilities.js';
import { readAuction, registerBids } from './bids.js';
import { systemClock, type Clock } from './clock.js';
import { createRealtime, type Realtime } from './realtime.js';

const connectionString = process.env.DATABASE_URL ?? process.env.DATABASE_URL!;

export function buildApp({ clock = systemClock, realtime: suppliedRealtime, redisUrl }: { clock?: Clock; realtime?: Realtime; redisUrl?: string } = {}) {
  const app = Fastify({ logger: true, requestIdHeader: 'x-request-id' });
  installHttpTracing(app);
  const pool = tracedPool({ connectionString, connectionTimeoutMillis: 1000 });
  const realtime = suppliedRealtime ?? createRealtime(app, pool, redisUrl);
  app.addHook('onReady', () => realtime.start());
  app.addHook('preClose', () => realtime.close());

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  app.get('/api/health', async (request, reply) => {
    try {
      await pool.query('SELECT 1');
      if (!realtime.healthy()) return reply.code(503).send({ ok: false, db: 'ok', redis: 'down', requestId: request.id });
      return { ok: true, db: 'ok', redis: 'ok', requestId: request.id };
    } catch (error) {
      request.log.error({ err: error }, 'database health check failed');
      return reply.code(503).send({ ok: false, db: 'down', requestId: request.id });
    }
  });

  app.addHook('onClose', async () => pool.end());

  app.get('/api/capabilities', async () => capabilities);
  if (capabilities.placeBids) registerBids(app, pool, clock, (slug) => realtime.publish(slug));
  app.get('/api/users', async () => {
    const result = await pool.query<{ id: string; displayName: string }>(
      'SELECT id, display_name AS "displayName" FROM demo_users ORDER BY sort_order');
    return result.rows;
  });

  app.get('/api/auctions', async (request, reply) => {
    const parsed = z.object({ q: z.string().max(200).optional() }).strict().safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ message: 'Invalid search query' });
    const query = parsed.data.q?.trim().toLowerCase() ?? '';
    const result = await pool.query<AuctionRow>(
      `${readAuction}
       WHERE strpos(lower(a.title || ' ' || a.category || ' ' || a.description || ' ' || coalesce(a.location, '')), $1) > 0
       ORDER BY a.created_at DESC, a.slug`, [query]);
    const asOf = clock();
    return result.rows.map((row) => auctionResponse(row, asOf));
  });

  app.get('/api/auctions/:slug', async (request, reply) => {
    const params = z.object({ slug: z.string().min(1).max(160) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ message: 'Invalid auction identifier' });
    const result = await pool.query<AuctionRow>(
      `${readAuction} WHERE a.slug = $1`, [params.data.slug]);
    if (!result.rows[0]) return reply.code(404).send({ message: 'Auction not found' });
    return auctionResponse(result.rows[0], clock());
  });

  if (capabilities.postAuctions) app.post('/api/auctions', async (request, reply) => {
    const parsed = createAuctionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: 'Please check the auction fields', errors: parsed.error.flatten().fieldErrors });
    const data = parsed.data;
    const slug = randomUUID();
    const result = await pool.query<AuctionRow>(
      `INSERT INTO auctions (slug,title,description,category,condition,seller,seller_id,location,starting_price_minor,ends_at,art)
       SELECT $1,$2,$3,$4,$5,u.display_name,u.id,$7,$8,$9,$10 FROM demo_users u WHERE u.id = $6 RETURNING *`,
      [slug, data.title, data.description, data.category, data.condition, data.sellerId, data.location, data.startingPrice, data.endsAt, artByCategory[data.category]]);
    if (!result.rows[0]) return reply.code(400).send({ message: 'Choose a valid demo user', errors: { sellerId: ['Choose a valid demo user in the footer.'] } });
    return reply.code(201).header('location', `/api/auctions/${slug}`).send(auctionResponse(result.rows[0], clock()));
  });
  registerCheckout(app, pool);
  return app;
}
