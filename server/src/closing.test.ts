import { afterAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { buildApp } from './app.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? process.env.DATABASE_URL! });
const deadline = new Date('2040-01-01T12:00:00.000Z');
const slugs: string[] = [];
const apps: ReturnType<typeof buildApp>[] = [];
async function fixture() {
  const slug = `closing-test-${randomUUID()}`;
  slugs.push(slug);
  await pool.query(`INSERT INTO auctions (slug,title,description,category,condition,seller,seller_id,starting_price_minor,ends_at,art)
    VALUES ($1,'Closing test','Test','Other','Used','Alex Morgan','alex-morgan',10000,$2,'chassis')`, [slug, deadline]);
  return slug;
}
afterAll(async () => {
  await Promise.all(apps.map((app) => app.close()));
  await pool.query('DELETE FROM bids WHERE auction_slug=ANY($1::text[])', [slugs]);
  await pool.query('DELETE FROM auctions WHERE slug=ANY($1::text[])', [slugs]);
  await pool.end();
});

it.each([
  { name: 'one millisecond before', offset: -1, status: 201 },
  { name: 'exactly at', offset: 0, status: 409 },
  { name: 'one millisecond after', offset: 1, status: 409 },
])('uses a single acceptance instant $name closing', async ({ offset, status }) => {
  const instant = new Date(deadline.getTime() + offset);
  // A second reading would cross closing and change the stored timestamp.
  const clock = vi.fn().mockReturnValueOnce(instant).mockReturnValue(new Date(deadline.getTime() + 1000));
  const app = buildApp({ clock }); apps.push(app);
  const slug = await fixture();
  const response = await app.inject({ method: 'POST', url: `/api/auctions/${slug}/bids`, payload: { bidderId: 'jordan-lee', amountMinor: 10100 } });
  expect(response.statusCode).toBe(status);
  expect(clock).toHaveBeenCalledTimes(1);
  const saved = await pool.query<{ accepted_at: Date }>('SELECT accepted_at FROM bids WHERE auction_slug=$1', [slug]);
  if (status === 201) {
    expect(response.json().auction.isClosed).toBe(false);
    expect(saved.rowCount).toBe(1);
    expect(saved.rows[0].accepted_at.toISOString()).toBe(instant.toISOString());
    expect(Date.parse(response.json().auction.bids[0].acceptedAt)).toBe(instant.getTime());
  } else {
    expect(saved.rowCount).toBe(0);
    expect(response.json()).toMatchObject({ message: 'This auction is closed.', auction: { isClosed: true, bidCount: 0, currentPriceMinor: 10000 } });
  }
});

it('reports server-closed status in detail and catalog reads using the application clock', async () => {
  const slug = await fixture();
  const app = buildApp({ clock: () => deadline }); apps.push(app);
  expect((await app.inject(`/api/auctions/${slug}`)).json().isClosed).toBe(true);
  const catalog = (await app.inject('/api/auctions?q=Closing%20test')).json() as { slug: string; isClosed: boolean }[];
  expect(catalog.find((item) => item.slug === slug)?.isClosed).toBe(true);
});

it('does not read the clock while waiting for a lock and rejects after the wait crosses closing', async () => {
  let now = new Date(deadline.getTime() - 1);
  const clock = vi.fn(() => now);
  const app = buildApp({ clock }); apps.push(app);
  const slug = await fixture();
  const blocker = await pool.connect();
  let request: Promise<Awaited<ReturnType<typeof app.inject>>> | undefined;
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT slug FROM auctions WHERE slug=$1 FOR UPDATE', [slug]);
    const pid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    request = Promise.resolve(app.inject({ method: 'POST', url: `/api/auctions/${slug}/bids`, payload: { bidderId: 'sam-rivera', amountMinor: 10100 } }));
    // Observe actual PostgreSQL contention; advance the clock only after the
    // request is waiting. The timeout is a failure bound, not a timing fixture.
    const limit = Date.now() + 4000;
    let waiting = false;
    while (Date.now() < limit) {
      const result = await pool.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
        AND query='SELECT * FROM auctions WHERE slug=$1 FOR UPDATE'
        AND wait_event_type='Lock' AND $1::int=ANY(pg_blocking_pids(pid))`, [pid]);
      if (result.rowCount) { waiting = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(waiting).toBe(true);
    expect(clock).not.toHaveBeenCalled();
    now = new Date(deadline.getTime() + 1);
    await blocker.query('COMMIT');
    const response = await request;
    expect(response.statusCode).toBe(409);
    expect(response.json().message).toBe('This auction is closed.');
    expect(clock).toHaveBeenCalledTimes(1);
    expect((await pool.query('SELECT * FROM bids WHERE auction_slug=$1', [slug])).rowCount).toBe(0);
  } finally {
    await blocker.query('ROLLBACK'); blocker.release();
    await request;
  }
});
