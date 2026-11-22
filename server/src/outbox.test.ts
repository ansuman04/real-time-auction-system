import { afterAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { closeDueAuctions } from './closing.js';
import { publishPendingOutbox, type CloseEvent, type ConfirmedPublisher } from './outbox.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? process.env.DATABASE_URL! });
const slugs: string[] = [];
async function dueAuction() {
  const slug = `outbox-test-${randomUUID()}`;
  slugs.push(slug);
  await pool.query(`INSERT INTO auctions (slug,title,description,category,condition,seller,seller_id,starting_price_minor,ends_at,art)
    VALUES ($1,'Outbox test','Test','Other','Used','Alex Morgan','alex-morgan',10000,now()-interval '1 second','chassis')`, [slug]);
  await closeDueAuctions(pool);
  return slug;
}
afterAll(async () => {
  await pool.query('DELETE FROM recipient_notifications WHERE auction_slug=ANY($1::text[])', [slugs]);
  await pool.query('DELETE FROM outbox_events WHERE auction_slug=ANY($1::text[])', [slugs]);
  await pool.query('DELETE FROM auction_closes WHERE auction_slug=ANY($1::text[])', [slugs]);
  await pool.query('DELETE FROM bids WHERE auction_slug=ANY($1::text[])', [slugs]);
  await pool.query('DELETE FROM auctions WHERE slug=ANY($1::text[])', [slugs]);
  await pool.end();
});

it('leaves an event pending if RabbitMQ does not confirm, then marks it only after confirmation', async () => {
  const slug = await dueAuction();
  const failing: ConfirmedPublisher = { publishConfirmed: async () => { throw new Error('broker nack'); } };
  await expect(publishPendingOutbox(pool, failing)).rejects.toThrow('broker nack');
  expect((await pool.query('SELECT published_at FROM outbox_events WHERE auction_slug=$1', [slug])).rows[0].published_at).toBeNull();

  let confirmed = false;
  const confirmedPublisher: ConfirmedPublisher = { publishConfirmed: async (_event: CloseEvent) => { confirmed = true; } };
  expect(await publishPendingOutbox(pool, confirmedPublisher)).toBe(1);
  expect(confirmed).toBe(true);
  expect((await pool.query('SELECT published_at FROM outbox_events WHERE auction_slug=$1', [slug])).rows[0].published_at).toBeInstanceOf(Date);
});
