import { context, trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import { parent, currentCarrier } from '@auction/telemetry';
import type pg from 'pg';

export interface CloseWorkerOptions {
  batchSize?: number;
}

interface DueAuction {
  slug: string;
  ends_at: Date;
}

interface WinningBid {
  id: string;
  bidder_id: string;
  amount_minor: number;
  trace_context: unknown;
}

export async function closeDueAuctions(pool: pg.Pool, { batchSize = 100 }: CloseWorkerOptions = {}): Promise<number> {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new RangeError('Close-worker batch size must be an integer from 1 to 100.');
  }

  const client = await pool.connect();
  const spans: Span[] = [];
  try {
    await client.query('BEGIN');
    const due = await client.query<DueAuction>(`SELECT a.slug, a.ends_at
      FROM auctions a
      LEFT JOIN auction_closes c ON c.auction_slug=a.slug
      WHERE a.ends_at <= clock_timestamp() AND c.auction_slug IS NULL
      ORDER BY a.ends_at, a.slug
      LIMIT $1
      FOR UPDATE OF a SKIP LOCKED`, [batchSize]);

    let closedCount = 0;
    for (const auction of due.rows) {
      const winningBid = (await client.query<WinningBid>(`SELECT id::text, bidder_id, amount_minor, trace_context
        FROM bids WHERE auction_slug=$1 ORDER BY amount_minor DESC, id DESC LIMIT 1`, [auction.slug])).rows[0];
      const origin = parent(winningBid?.trace_context);
      const linked = trace.getSpanContext(origin);
      const closeSpan = trace.getTracer('auction-business').startSpan('auction.close', { attributes: { 'auction.id': auction.slug, 'bid.id': winningBid?.id ?? 'none', 'amount.minor': winningBid?.amount_minor ?? 0, currency: 'usd', 'deadline.late_ms': Math.max(0, Date.now() - auction.ends_at.getTime()) }, links: linked ? [{ context: linked }] : [] }, origin);
      spans.push(closeSpan);
      await context.with(trace.setSpan(origin, closeSpan), async () => {
        const close = await client.query(`INSERT INTO auction_closes
          (auction_slug, closed_at, winning_bid_id, winner_id, winning_amount_minor, trace_context)
          VALUES ($1, $2, $3, $4, $5, $6::jsonb)
          ON CONFLICT (auction_slug) DO NOTHING
          RETURNING auction_slug`, [
          auction.slug,
          auction.ends_at,
          winningBid?.id ?? null,
          winningBid?.bidder_id ?? null,
          winningBid?.amount_minor ?? null,
          JSON.stringify(currentCarrier() ?? null),
        ]);
        if (!close.rowCount) return;

        const payload = {
          auctionSlug: auction.slug,
          closedAt: auction.ends_at.toISOString(),
          winningBid: winningBid ? {
            bidId: winningBid.id,
            bidderId: winningBid.bidder_id,
            amountMinor: winningBid.amount_minor,
          } : null,
        };
        await client.query(`INSERT INTO outbox_events (auction_slug, event_type, payload, trace_context)
          VALUES ($1, 'auction.closed', $2::jsonb, $3::jsonb)`, [auction.slug, JSON.stringify(payload), JSON.stringify(currentCarrier() ?? null)]);
        closedCount++;
      });
    }

    await client.query('COMMIT');
    for (const s of spans) { s.setAttribute('outcome', 'recorded'); s.end(); }
    return closedCount;
  } catch (error) {
    for (const s of spans) { s.setStatus({ code: SpanStatusCode.ERROR }); s.setAttribute('outcome', 'rolled_back'); s.end(); }
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
