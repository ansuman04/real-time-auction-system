import { afterAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { buildApp } from './app.js';

const app = buildApp();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? process.env.DATABASE_URL! });
const slugs: string[] = [];
async function auction(price = 10000, ended = false) {
  const slug = `bid-test-${randomUUID()}`;
  slugs.push(slug);
  await pool.query(`INSERT INTO auctions (slug,title,description,category,condition,seller,seller_id,starting_price_minor,ends_at,art)
    VALUES ($1,'Bid test','Test','Other','Used','Alex Morgan','alex-morgan',$2,now() + $3::interval,'chassis')`, [slug, price, ended ? '-1 hour' : '1 day']);
  return slug;
}
const bid = (slug: string, amountMinor: number, bidderId = 'jordan-lee') =>
  app.inject({ method: 'POST', url: `/api/auctions/${slug}/bids`, payload: { bidderId, amountMinor } });

afterAll(async () => {
  await app.close();
  await pool.query('DELETE FROM bids WHERE auction_slug=ANY($1::text[])', [slugs]);
  await pool.query('DELETE FROM auctions WHERE slug=ANY($1::text[])', [slugs]);
  await pool.end();
});

async function waitForBlockedBidders(count: number) {
  const limit = Date.now() + 4000;
  while (Date.now() < limit) {
    const result = await pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname=current_database() AND query='SELECT * FROM auctions WHERE slug=$1 FOR UPDATE'
      AND wait_event_type='Lock'`);
    if (result.rows[0].count >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Expected ${count} bidders to wait for the auction row lock`);
}

it('accepts exact cents, persists public history, and enforces an increment on the first and later bid', async () => {
  const slug = await auction(10001);
  expect((await bid(slug, 10100)).statusCode).toBe(409);
  const first = await bid(slug, 10101);
  expect(first.statusCode).toBe(201);
  expect(first.json().auction).toMatchObject({ currentPriceMinor: 10101, bidCount: 1, bids: [{ bidderId: 'jordan-lee', bidderName: 'Jordan Lee', amountMinor: 10101 }] });
  expect((await bid(slug, 10101, 'sam-rivera')).statusCode).toBe(409);
  expect((await bid(slug, 10201, 'sam-rivera')).statusCode).toBe(201);
  const anotherApp = buildApp();
  try {
    const saved = (await anotherApp.inject(`/api/auctions/${slug}`)).json();
    expect(saved.bidCount).toBe(2);
    expect(saved.bids.map((row: { amountMinor: number }) => row.amountMinor)).toEqual([10201, 10101]);
    expect(Date.parse(saved.bids[0].acceptedAt)).toBeGreaterThan(0);
    expect((await anotherApp.inject('/api/auctions?q=Bid%20test')).json().find((row: { slug: string }) => row.slug === slug).currentPriceMinor).toBe(10201);
  } finally { await anotherApp.close(); }
});

it('serializes genuinely contending equal bids: exactly one accepted bid and one stale conflict', async () => {
  const slug = await auction();
  const blocker = await pool.connect();
  let attempts: Promise<unknown> | undefined;
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT slug FROM auctions WHERE slug=$1 FOR UPDATE', [slug]);
    const responses = Promise.all([bid(slug, 10100), bid(slug, 10100, 'sam-rivera')]);
    attempts = responses;
    await waitForBlockedBidders(2);
    await blocker.query('COMMIT');
    const results = await responses;
    expect(results.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    expect(results.find((response) => response.statusCode === 409)!.json().auction).toMatchObject({ currentPriceMinor: 10100, bidCount: 1 });
    expect((await pool.query('SELECT amount_minor FROM bids WHERE auction_slug=$1', [slug])).rows).toEqual([{ amount_minor: 10100 }]);
  } finally {
    await blocker.query('ROLLBACK'); blocker.release();
    await attempts;
  }
});

it('reads the latest committed bid after waiting for the lock, rather than validating a pre-lock snapshot', async () => {
  const slug = await auction();
  const blocker = await pool.connect();
  let attempt: ReturnType<typeof bid> | undefined;
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT slug FROM auctions WHERE slug=$1 FOR UPDATE', [slug]);
    attempt = bid(slug, 10100);
    // Fastify injection is thenable; consume it to dispatch before observing the lock wait.
    const response = Promise.resolve(attempt);
    await waitForBlockedBidders(1);
    await blocker.query(`INSERT INTO bids (auction_slug,bidder_id,amount_minor,accepted_at) VALUES ($1,'sam-rivera',10500,now())`, [slug]);
    await blocker.query('COMMIT');
    const result = await response;
    expect(result.statusCode).toBe(409);
    expect(result.json().auction).toMatchObject({ currentPriceMinor: 10500, bidCount: 1 });
    expect((await bid(slug, 10600)).statusCode).toBe(201);
  } finally { await blocker.query('ROLLBACK'); blocker.release(); if (attempt) await attempt; }
});

it('rejects sellers, unknown identities/auctions, closed auctions and malformed amounts without inserting bids', async () => {
  const slug = await auction();
  expect((await bid(slug, 10100, 'alex-morgan')).statusCode).toBe(403);
  expect((await bid(slug, 10100, 'unknown-user')).statusCode).toBe(400);
  expect((await bid('missing-bid-auction', 10100)).statusCode).toBe(404);
  for (const value of [0, -1, 10100.5, 1000000000]) expect((await bid(slug, value)).statusCode).toBe(400);
  expect((await app.inject({ method: 'POST', url: `/api/auctions/${slug}/bids`, payload: { bidderId: 'jordan-lee', amountMinor: '10100' } })).statusCode).toBe(400);
  const closed = await auction(10000, true);
  expect((await bid(closed, 10100)).statusCode).toBe(409);
  expect((await pool.query('SELECT * FROM bids WHERE auction_slug=ANY($1::text[])', [[slug, closed]])).rowCount).toBe(0);
  // A rejected transaction must release its lock/connection so the next valid bid succeeds.
  expect((await bid(slug, 10100)).statusCode).toBe(201);
});

it('preserves the money ceiling when no valid minimum remains', async () => {
  const slug = await auction(999999950);
  expect((await bid(slug, 999999999)).statusCode).toBe(409);
  expect((await pool.query('SELECT * FROM bids WHERE auction_slug=$1', [slug])).rowCount).toBe(0);
});

it('blocks the highest bidder until outbid, then allows them to bid again', async () => {
  const slug = await auction();
  expect((await bid(slug, 10100)).statusCode).toBe(201);
  const repeated = await bid(slug, 10200);
  expect(repeated.statusCode).toBe(409);
  expect(repeated.json()).toMatchObject({ message: 'You are the highest bidder. You can bid again after someone outbids you.', auction: { bidCount: 1, currentPriceMinor: 10100 } });
  expect((await bid(slug, 10200, 'sam-rivera')).statusCode).toBe(201);
  expect((await bid(slug, 10300)).statusCode).toBe(201);
  expect((await pool.query('SELECT bidder_id,amount_minor FROM bids WHERE auction_slug=$1 ORDER BY id', [slug])).rows).toEqual([
    { bidder_id: 'jordan-lee', amount_minor: 10100 }, { bidder_id: 'sam-rivera', amount_minor: 10200 }, { bidder_id: 'jordan-lee', amount_minor: 10300 },
  ]);
});

it('checks highest-bidder status after waiting for the auction lock', async () => {
  const slug = await auction();
  const blocker = await pool.connect();
  let attempt: Promise<Awaited<ReturnType<typeof app.inject>>> | undefined;
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT slug FROM auctions WHERE slug=$1 FOR UPDATE', [slug]);
    attempt = Promise.resolve(bid(slug, 10200));
    await waitForBlockedBidders(1);
    // A different session using the same identity becomes leader while the
    // request waits. A pre-lock check would incorrectly accept its higher bid.
    await blocker.query(`INSERT INTO bids (auction_slug,bidder_id,amount_minor,accepted_at) VALUES ($1,'jordan-lee',10100,now())`, [slug]);
    await blocker.query('COMMIT');
    const response = await attempt;
    expect(response.statusCode).toBe(409);
    expect(response.json().message).toContain('highest bidder');
    expect((await pool.query('SELECT amount_minor FROM bids WHERE auction_slug=$1', [slug])).rows).toEqual([{ amount_minor: 10100 }]);
  } finally { await blocker.query('ROLLBACK'); blocker.release(); await attempt; }
});
