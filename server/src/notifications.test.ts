import { afterAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { closeDueAuctions } from './closing.js';
import { persistRecipientNotifications, notificationChannel } from './notificationDelivery.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? process.env.DATABASE_URL! });
const slugs: string[] = [];
const signals: Array<{ channel: string; message: string }> = [];
const publisher = { publish: async (channel: string, message: string) => { signals.push({ channel, message }); } };

async function closedFixture(withBid: boolean) {
  const slug = `notification-test-${randomUUID()}`;
  slugs.push(slug);
  await pool.query(`INSERT INTO auctions (slug,title,description,category,condition,seller,seller_id,starting_price_minor,ends_at,art)
    VALUES ($1,'Notification test','Test','Other','Used','Alex Morgan','alex-morgan',10000,now()-interval '1 second','chassis')`, [slug]);
  if (withBid) await pool.query(`INSERT INTO bids (auction_slug,bidder_id,amount_minor,accepted_at)
    VALUES ($1,'jordan-lee',12500,now()-interval '2 seconds')`, [slug]);
  await closeDueAuctions(pool);
  await pool.query("UPDATE outbox_events SET published_at=clock_timestamp() WHERE auction_slug=$1", [slug]);
  return (await pool.query(`SELECT e.event_id::text AS "eventId", e.event_type AS "eventType", e.auction_slug AS "auctionSlug", e.payload
    FROM outbox_events e WHERE e.auction_slug=$1`, [slug])).rows[0];
}

afterAll(async () => {
  await pool.query('DELETE FROM recipient_notifications WHERE auction_slug=ANY($1::text[])', [slugs]);
  await pool.query('DELETE FROM outbox_events WHERE auction_slug=ANY($1::text[])', [slugs]);
  await pool.query('DELETE FROM auction_closes WHERE auction_slug=ANY($1::text[])', [slugs]);
  await pool.query('DELETE FROM bids WHERE auction_slug=ANY($1::text[])', [slugs]);
  await pool.query('DELETE FROM auctions WHERE slug=ANY($1::text[])', [slugs]);
  await pool.end();
});

it('handles RabbitMQ redelivery idempotently and selects seller plus winning bidder', async () => {
  const event = await closedFixture(true);
  const first = await persistRecipientNotifications(pool, publisher, event);
  const second = await persistRecipientNotifications(pool, publisher, event);
  const stored = await pool.query(`SELECT recipient_id, recipient_role FROM recipient_notifications WHERE event_id=$1 ORDER BY recipient_role`, [event.eventId]);
  expect(first).toHaveLength(2);
  expect(second).toHaveLength(2);
  expect(stored.rows).toEqual([
    { recipient_id: 'alex-morgan', recipient_role: 'seller' },
    { recipient_id: 'jordan-lee', recipient_role: 'winner' },
  ]);
  expect((await pool.query('SELECT count(*)::int AS count FROM recipient_notifications WHERE event_id=$1', [event.eventId])).rows[0].count).toBe(2);
  expect(signals.every((signal) => signal.channel === notificationChannel)).toBe(true);
});

it('sends a no-bid close only to the seller', async () => {
  const event = await closedFixture(false);
  const notifications = await persistRecipientNotifications(pool, publisher, event);
  expect(notifications).toHaveLength(1);
  expect(notifications[0]).toMatchObject({ recipientId: 'alex-morgan', recipientRole: 'seller', payload: { winner: null } });
});
