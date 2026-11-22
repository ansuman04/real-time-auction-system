import { annotate, currentCarrier } from '@auction/telemetry';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { auctionResponse, type AuctionRow } from './auctions.js';
import type { Clock } from './clock.js';

// One statement gives the price and history the same PostgreSQL snapshot.
export const readAuction = `SELECT a.*, u.display_name AS seller,
  c.auction_slug AS close_auction_slug, c.closed_at AS close_closed_at,
  c.winning_bid_id::text AS close_winning_bid_id, c.winner_id AS close_winner_id,
  winner.display_name AS close_winner_name, c.winning_amount_minor AS close_winning_amount_minor,
  coalesce((SELECT json_agg(h ORDER BY h.id::bigint DESC) FROM (
    SELECT b.id::text AS id, b.amount_minor AS "amountMinor",
      b.bidder_id AS "bidderId", bu.display_name AS "bidderName",
      b.accepted_at AS "acceptedAt"
    FROM bids b JOIN demo_users bu ON bu.id=b.bidder_id
    WHERE b.auction_slug=a.slug ORDER BY b.id DESC
  ) h), '[]'::json) AS bids
  FROM auctions a
  JOIN demo_users u ON u.id=a.seller_id
  LEFT JOIN auction_closes c ON c.auction_slug=a.slug
  LEFT JOIN demo_users winner ON winner.id=c.winner_id`;

export function registerBids(app: FastifyInstance, pool: pg.Pool, clock: Clock, publish: (slug: string) => Promise<void>) {
  app.post('/api/auctions/:slug/bids', async (request, reply) => {
    const params = z.object({ slug: z.string().min(1).max(160) }).safeParse(request.params);
    const body = z.object({ bidderId: z.string().min(1).max(80), amountMinor: z.number().int().min(1).max(999999999) }).strict().safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ message: 'Choose a valid bidder and enter a USD amount with at most two decimals.' });
    annotate({ 'auction.id': params.data.slug, 'amount.minor': body.data.amountMinor, currency: 'usd', role: 'bidder' });
    const client = await pool.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      const locked = await client.query<AuctionRow>('SELECT * FROM auctions WHERE slug=$1 FOR UPDATE', [params.data.slug]);
      if (!locked.rows[0]) {
        await client.query('ROLLBACK');
        return reply.code(404).send({ message: 'Auction not found' });
      }
      // No current-price read or business validation occurs before the lock.
      const state = (await client.query<AuctionRow>(`${readAuction} WHERE a.slug=$1`, [params.data.slug])).rows[0];
      const user = await client.query('SELECT id FROM demo_users WHERE id=$1', [body.data.bidderId]);
      // One acceptance instant, read only after the lock and latest-state reads.
      // A request that waited across closing must use its new acceptance time.
      const acceptedAt = clock();
      const auction = auctionResponse(state, acceptedAt);
      let rejection: { status: number; message: string } | undefined;
      if (!user.rowCount) rejection = { status: 400, message: 'Choose a valid demo user.' };
      else if (state.seller_id === body.data.bidderId) rejection = { status: 403, message: 'Sellers cannot bid on their own auction.' };
      else if (acceptedAt >= state.ends_at) rejection = { status: 409, message: 'This auction is closed.' };
      else if (auction.bids[0]?.bidderId === body.data.bidderId) rejection = { status: 409, message: 'You are the highest bidder. You can bid again after someone outbids you.' };
      else if (body.data.amountMinor < auction.currentPriceMinor + 100) rejection = { status: 409, message: 'Your bid is below the updated minimum. Review the latest price and submit a new amount.' };
      if (rejection) {
        annotate({ outcome: 'rejected' });
        await client.query('ROLLBACK');
        return reply.code(rejection.status).send({ message: rejection.message, auction });
      }
      const inserted = await client.query('INSERT INTO bids (auction_slug,bidder_id,amount_minor,accepted_at,trace_context) VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING id::text',
        [params.data.slug, body.data.bidderId, body.data.amountMinor, acceptedAt, JSON.stringify(currentCarrier() ?? null)]);
      annotate({ 'bid.id': inserted.rows[0].id, outcome: 'accepted' });
      const updated = (await client.query<AuctionRow>(`${readAuction} WHERE a.slug=$1`, [params.data.slug])).rows[0];
      await client.query('COMMIT');
      committed = true;
      try { await publish(params.data.slug); }
      catch (error) { request.log.error({ err: error, auctionSlug: params.data.slug }, 'accepted bid notification failed after commit'); }
      return reply.code(201).send({ auction: auctionResponse(updated, acceptedAt) });
    } catch (error) {
      if (!committed) await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  });
}
