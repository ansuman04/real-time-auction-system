import { span, type TraceCarrier } from '@auction/telemetry';
import type pg from 'pg';
import { z } from 'zod';

const closedOutcomeSchema = z.object({
  auctionSlug: z.string().min(1).max(160),
  closedAt: z.string().datetime(),
  winningBid: z.object({
    bidId: z.string().regex(/^\d+$/),
    bidderId: z.string().min(1).max(80),
    amountMinor: z.number().int().min(1).max(999999999),
  }).strict().nullable(),
}).strict();

export interface CloseEvent {
  eventId: string;
  eventType: 'auction.closed';
  auctionSlug: string;
  payload: z.infer<typeof closedOutcomeSchema>;
}

export interface PaymentEvent { eventId: string; eventType: 'payment.paid'; auctionSlug: string; payload: { auctionSlug: string } }
export type OutboxEvent = CloseEvent | PaymentEvent;

export interface ConfirmedPublisher {
  publishConfirmed(event: OutboxEvent): Promise<void>;
}

interface PendingOutboxRow {
  event_id: string;
  auction_slug: string;
  event_type: 'auction.closed' | 'payment.paid';
  payload: unknown;
  trace_context: TraceCarrier | null;
  created_at: Date;
}

export async function publishPendingOutbox(
  pool: pg.Pool,
  publisher: ConfirmedPublisher,
  batchSize = 25,
): Promise<number> {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new RangeError('Outbox batch size must be an integer from 1 to 100.');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rows = await client.query<PendingOutboxRow>(`SELECT event_id::text, auction_slug, event_type, payload, trace_context, created_at
      FROM outbox_events
      WHERE published_at IS NULL
      ORDER BY created_at, event_id
      LIMIT $1
      FOR UPDATE SKIP LOCKED`, [batchSize]);

    for (const row of rows.rows) {
      const event: OutboxEvent = row.event_type === 'payment.paid' ? {
        eventId: row.event_id, eventType: row.event_type, auctionSlug: row.auction_slug,
        payload: z.object({ auctionSlug: z.string().min(1).max(160) }).strict().parse(row.payload),
      } : {
        eventId: row.event_id,
        eventType: row.event_type,
        auctionSlug: row.auction_slug,
        payload: closedOutcomeSchema.parse(row.payload),
      };
      await span('outbox.publish', { 'event.id': event.eventId, 'auction.id': event.auctionSlug, 'queue.age_ms': Math.max(0, Date.now()-row.created_at.getTime()) }, async () => {
        await publisher.publishConfirmed(event);
        // A confirmed broker delivery may be replayed if the surrounding DB transaction fails.

        await client.query(`UPDATE outbox_events SET published_at=clock_timestamp()
          WHERE event_id=$1 AND published_at IS NULL`, [row.event_id]);
      }, row.trace_context);
    }

    await client.query('COMMIT');
    return rows.rowCount ?? 0;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
