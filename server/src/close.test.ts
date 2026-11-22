import { afterAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { buildApp } from './app.js';
import type { Realtime } from './realtime.js';
import { closeDueAuctions } from './closing.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? process.env.DATABASE_URL! });
const slugs: string[] = [];
const inertRealtime: Realtime = { start: async () => {}, close: async () => {}, healthy: () => true, publish: async () => {} };

async function auction(endsIn: string) {
  const slug = `close-test-${randomUUID()}`;
  slugs.push(slug);
  await pool.query(`INSERT INTO auctions
    (slug,title,description,category,condition,seller,seller_id,starting_price_minor,ends_at,art)
    VALUES ($1,'Close test','Test','Other','Used','Alex Morgan','alex-morgan',10000,now()+$2::interval,'chassis')`, [slug, endsIn]);
  return slug;
}

async function bid(slug: string, bidderId: string, amountMinor: number) {
  await pool.query(`INSERT INTO bids (auction_slug,bidder_id,amount_minor,accepted_at)
    VALUES ($1,$2,$3,now())`, [slug, bidderId, amountMinor]);
}

afterAll(async () => {
  await pool.query('DELETE FROM outbox_events WHERE auction_slug=ANY($1::text[])', [slugs]);
  await pool.query('DELETE FROM auction_closes WHERE auction_slug=ANY($1::text[])', [slugs]);
  await pool.query('DELETE FROM bids WHERE auction_slug=ANY($1::text[])', [slugs]);
  await pool.query('DELETE FROM auctions WHERE slug=ANY($1::text[])', [slugs]);
  await pool.end();
});

it('waits until the database deadline, then records the highest accepted bid and one outbox event', async () => {
  const slug = await auction('1 day');
  await bid(slug, 'jordan-lee', 10100);
  await bid(slug, 'sam-rivera', 10200);
  await bid(slug, 'jordan-lee', 10100);

  expect(await closeDueAuctions(pool)).toBe(0);
  expect((await pool.query('SELECT 1 FROM auction_closes WHERE auction_slug=$1', [slug])).rowCount).toBe(0);

  await pool.query('UPDATE auctions SET ends_at=clock_timestamp() WHERE slug=$1', [slug]);
  expect(await closeDueAuctions(pool)).toBe(1);
  const result = await pool.query(`SELECT c.closed_at, c.winning_bid_id::text, c.winner_id, c.winning_amount_minor,
      o.event_type, o.payload
    FROM auction_closes c JOIN outbox_events o USING (auction_slug) WHERE c.auction_slug=$1`, [slug]);
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]).toMatchObject({
    winner_id: 'sam-rivera', winning_amount_minor: 10200, event_type: 'auction.closed',
    payload: { auctionSlug: slug, winningBid: { bidderId: 'sam-rivera', amountMinor: 10200 } },
  });
  const app = buildApp({ realtime: inertRealtime });
  try {
    const detail = await app.inject(`/api/auctions/${slug}`);
    expect(detail.json()).toMatchObject({
      isClosed: true,
      finalOutcome: { winningBid: { bidderId: 'sam-rivera', bidderName: 'Sam Rivera', amountMinor: 10200 } },
    });
  } finally { await app.close(); }
});

it('records a no-bid close and exactly one corresponding event', async () => {
  const slug = await auction('-1 second');
  expect(await closeDueAuctions(pool)).toBe(1);
  const result = await pool.query(`SELECT c.winning_bid_id, c.winner_id, c.winning_amount_minor,
      o.event_type, o.payload
    FROM auction_closes c JOIN outbox_events o USING (auction_slug) WHERE c.auction_slug=$1`, [slug]);
  expect(result.rows).toEqual([{
    winning_bid_id: null, winner_id: null, winning_amount_minor: null,
    event_type: 'auction.closed', payload: { auctionSlug: slug, winningBid: null, closedAt: expect.any(String) },
  }]);
});

it('is idempotent when the same due auction is processed repeatedly', async () => {
  const slug = await auction('-1 second');
  expect(await closeDueAuctions(pool)).toBe(1);
  expect(await closeDueAuctions(pool)).toBe(0);
  const counts = await pool.query(`SELECT
      (SELECT count(*)::int FROM auction_closes WHERE auction_slug=$1) AS closes,
      (SELECT count(*)::int FROM outbox_events WHERE auction_slug=$1 AND event_type='auction.closed') AS events`, [slug]);
  expect(counts.rows[0]).toEqual({ closes: 1, events: 1 });
  await expect(pool.query(`INSERT INTO auction_closes (auction_slug,closed_at)
    SELECT slug, ends_at FROM auctions WHERE slug=$1`, [slug])).rejects.toMatchObject({ code: '23505' });
  await expect(pool.query(`INSERT INTO outbox_events (auction_slug,event_type,payload)
    VALUES ($1,'auction.closed','{}'::jsonb)`, [slug])).rejects.toMatchObject({ code: '23505' });
});

it('coordinates concurrent workers so every auction has exactly one close and one event', async () => {
  const fixtures = await Promise.all(Array.from({ length: 12 }, () => auction('-1 second')));
  const claims = await Promise.all(Array.from({ length: 6 }, () => closeDueAuctions(pool, { batchSize: 2 })));
  expect(claims.reduce((total, count) => total + count, 0)).toBe(fixtures.length);

  const results = await pool.query(`SELECT auction_slug, count(DISTINCT c.auction_slug)::int AS closes,
      count(DISTINCT o.event_id)::int AS events
    FROM auction_closes c JOIN outbox_events o USING (auction_slug)
    WHERE c.auction_slug=ANY($1::text[]) GROUP BY auction_slug`, [fixtures]);
  expect(results.rows).toHaveLength(fixtures.length);
  expect(results.rows.every((row) => row.closes === 1 && row.events === 1)).toBe(true);
});
