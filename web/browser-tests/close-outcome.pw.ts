import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, test } from '@playwright/test';
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? process.env.DATABASE_URL!,
});
const slugs: string[] = [];

async function createEndedAuction(withBid: boolean) {
  const slug = `browser-close-${randomUUID()}`;
  slugs.push(slug);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO auctions
    (slug,title,description,category,condition,seller,seller_id,location,starting_price_minor,ends_at,art)
    VALUES ($1,'Browser close review','Final outcome review','Other','Used','Alex Morgan','alex-morgan','Minneapolis, MN',10000,clock_timestamp()+interval '1 hour','chassis')`, [slug]);
    const bid = withBid ? (await client.query<{ id: string }>(`INSERT INTO bids (auction_slug,bidder_id,amount_minor,accepted_at)
      VALUES ($1,'jordan-lee',10300,clock_timestamp()) RETURNING id::text`, [slug])).rows[0] : undefined;
    await client.query(`INSERT INTO auction_closes
      (auction_slug,closed_at,winning_bid_id,winner_id,winning_amount_minor)
      VALUES ($1,clock_timestamp(),$2,$3,$4)`, [slug, bid?.id ?? null, bid ? 'jordan-lee' : null, bid ? 10300 : null]);
    await client.query(`INSERT INTO outbox_events (auction_slug,event_type,payload,published_at)
      VALUES ($1,'auction.closed',$2::jsonb,clock_timestamp())`, [slug, JSON.stringify({ auctionSlug: slug, winningBid: bid ? { bidId: bid.id, bidderId: 'jordan-lee', amountMinor: 10300 } : null })]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return slug;
}

test.afterAll(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT slug FROM auctions WHERE slug=ANY($1::text[]) FOR UPDATE', [slugs]);
    await client.query('DELETE FROM recipient_notifications WHERE auction_slug=ANY($1::text[])', [slugs]);
    await client.query('DELETE FROM outbox_events WHERE auction_slug=ANY($1::text[])', [slugs]);
    await client.query('DELETE FROM auction_closes WHERE auction_slug=ANY($1::text[])', [slugs]);
    await client.query('DELETE FROM bids WHERE auction_slug=ANY($1::text[])', [slugs]);
    await client.query('DELETE FROM auctions WHERE slug=ANY($1::text[])', [slugs]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  await pool.end();
});

test('shows the durable winning-bid and no-bid outcomes on auction detail pages', async ({ page }) => {
  const winnerSlug = await createEndedAuction(true);
  const noBidSlug = await createEndedAuction(false);
  await page.goto(`/items/${winnerSlug}`);
  await expect(page.getByTestId('auction-status')).toHaveText('Ended');
  await expect(page.getByTestId('final-outcome')).toContainText('Jordan Lee');
  await expect(page.getByTestId('final-outcome')).toContainText('$103.00');

  await page.goto(`/items/${noBidSlug}`);
  await expect(page.getByTestId('auction-status')).toHaveText('Ended');
  await expect(page.getByTestId('final-outcome')).toContainText('No bids were placed. This auction closed without a winner.');
});
