import { span, currentCarrier, annotate } from '@auction/telemetry';
import type pg from 'pg';
import { z } from 'zod';
import type { NotificationPublisher } from './notificationDelivery.js';

export const paymentChannel = 'auction-part-8:payment-changed';
export const paymentEventSchema = z.object({
  eventId: z.string().uuid(), eventType: z.literal('payment.paid'),
  auctionSlug: z.string().min(1).max(160),
  payload: z.object({ auctionSlug: z.string().min(1).max(160) }).strict(),
}).strict();

export async function deliverPaymentChange(pool: pg.Pool, publisher: NotificationPublisher, input: unknown) {
  const event = paymentEventSchema.parse(input);
  if (event.payload.auctionSlug !== event.auctionSlug) throw new Error('Mismatched payment event');
  annotate({ 'event.id': event.eventId, 'auction.id': event.auctionSlug });
  const client = await pool.connect();
  let recipients: { recipient_id: string }[];
  try {
    await client.query('BEGIN');
    const result = await client.query<{ seller_id: string; buyer_id: string }>(`SELECT a.seller_id,p.buyer_id
      FROM outbox_events e JOIN purchases p ON p.auction_slug=e.auction_slug
      JOIN auctions a ON a.slug=p.auction_slug
      WHERE e.event_id=$1 AND e.event_type='payment.paid' AND e.auction_slug=$2
        AND e.published_at IS NOT NULL AND p.paid_at IS NOT NULL`, [event.eventId, event.auctionSlug]);
    if (!result.rows[0]) throw new Error('Missing published payment event');
    const outcome = result.rows[0];
    for (const id of new Set([outcome.seller_id, outcome.buyer_id])) {
      await client.query(`INSERT INTO payment_deliveries (event_id,recipient_id,auction_slug)
        VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [event.eventId, id, event.auctionSlug]);
    }
    recipients = (await client.query<{ recipient_id: string }>('SELECT recipient_id FROM payment_deliveries WHERE event_id=$1', [event.eventId])).rows;
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  // Repeat signals are harmless; publish again on redelivery if Redis failed.
  for (const recipient of recipients) await span('payment.signal', { 'event.id': event.eventId, 'auction.id': event.auctionSlug, outcome: 'paid' }, async () => publisher.publish(paymentChannel,
    JSON.stringify({ eventId: event.eventId, recipientId: recipient.recipient_id, traceContext: currentCarrier() })));
}
