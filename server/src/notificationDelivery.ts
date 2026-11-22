import { span, currentCarrier, annotate } from '@auction/telemetry';
import { deliverPaymentChange } from './paymentDelivery.js';
import type pg from 'pg';
import { z } from 'zod';
import type { CloseEvent } from './outbox.js';

export const notificationChannel = 'auction-part-8:notifications';

export interface RecipientNotification {
  notificationId: string;
  recipientId: string;
  recipientRole: 'seller' | 'winner';
  payload: {
    auctionSlug: string;
    auctionTitle: string;
    closedAt: string;
    sellerName: string;
    recipientRole: 'seller' | 'winner';
    winner: null | { bidderId: string; bidderName: string; amountMinor: number };
  };
  createdAt: string;
}

export interface NotificationPublisher {
  publish(channel: string, message: string): Promise<unknown>;
}

export interface NotificationRealtimePublisher extends NotificationPublisher {
  subscribe?(channel: string, listener: (message: string) => void): Promise<unknown>;
}

interface ClosedAuctionRow {
  auction_slug: string;
  event_type: string;
  published_at: Date | null;
  closed_at: Date;
  auction_title: string;
  seller_id: string;
  seller_name: string;
  winner_id: string | null;
  winner_name: string | null;
  winning_amount_minor: number | null;
}

interface NotificationRow {
  notification_id: string;
  recipient_id: string;
  recipient_role: 'seller' | 'winner';
  payload: RecipientNotification['payload'];
  created_at: Date;
}

const closedEventSchema = z.object({
  eventId: z.string().uuid(),
  eventType: z.literal('auction.closed'),
  auctionSlug: z.string().min(1).max(160),
  payload: z.object({ auctionSlug: z.string().min(1).max(160) }).passthrough(),
}).passthrough();

export async function persistRecipientNotifications(
  pool: pg.Pool,
  publisher: NotificationPublisher,
  input: unknown,
): Promise<RecipientNotification[]> {
  if (typeof input === 'object' && input !== null && 'eventType' in input && input.eventType === 'payment.paid') {
    await deliverPaymentChange(pool, publisher, input);
    return [];
  }
  const parsed = closedEventSchema.safeParse(input);
  if (!parsed.success || parsed.data.payload.auctionSlug !== parsed.data.auctionSlug) {
    throw new Error('Invalid auction.closed event.');
  }

  annotate({ 'event.id': parsed.data.eventId, 'auction.id': parsed.data.auctionSlug });
  const client = await pool.connect();
  let notifications: RecipientNotification[] = [];
  try {
    await client.query('BEGIN');
    const outcome = (await client.query<ClosedAuctionRow>(`SELECT e.auction_slug, e.event_type, e.published_at,
        c.closed_at, a.title AS auction_title, a.seller_id, seller.display_name AS seller_name,
        c.winner_id, winner.display_name AS winner_name, c.winning_amount_minor
      FROM outbox_events e
      JOIN auction_closes c USING (auction_slug)
      JOIN auctions a ON a.slug=c.auction_slug
      JOIN demo_users seller ON seller.id=a.seller_id
      LEFT JOIN demo_users winner ON winner.id=c.winner_id
      WHERE e.event_id=$1`, [parsed.data.eventId])).rows[0];
    if (!outcome || outcome.event_type !== 'auction.closed' || outcome.auction_slug !== parsed.data.auctionSlug || !outcome.published_at) {
      throw new Error('The auction close event is missing, unpublished, or does not match its outcome.');
    }

    const winner = outcome.winner_id && outcome.winner_name && outcome.winning_amount_minor !== null ? {
      bidderId: outcome.winner_id,
      bidderName: outcome.winner_name,
      amountMinor: outcome.winning_amount_minor,
    } : null;
    const basePayload = {
      auctionSlug: outcome.auction_slug,
      auctionTitle: outcome.auction_title,
      closedAt: outcome.closed_at.toISOString(),
      sellerName: outcome.seller_name,
      winner,
    };
    const recipients: Array<{ recipientId: string; recipientRole: 'seller' | 'winner' }> = [
      { recipientId: outcome.seller_id, recipientRole: 'seller' },
    ];
    if (outcome.winner_id && outcome.winner_id !== outcome.seller_id) {
      recipients.push({ recipientId: outcome.winner_id, recipientRole: 'winner' });
    }

    for (const recipient of recipients) {
      const payload = { ...basePayload, recipientRole: recipient.recipientRole };
      await client.query(`INSERT INTO recipient_notifications
        (event_id, auction_slug, recipient_id, recipient_role, payload, trace_context)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
        ON CONFLICT (event_id, recipient_id) DO NOTHING`, [
        parsed.data.eventId, outcome.auction_slug, recipient.recipientId,
        recipient.recipientRole, JSON.stringify(payload), JSON.stringify(currentCarrier() ?? null),
      ]);
    }

    const rows = await client.query<NotificationRow>(`SELECT notification_id::text, recipient_id, recipient_role, payload, created_at
      FROM recipient_notifications WHERE event_id=$1 ORDER BY created_at, notification_id`, [parsed.data.eventId]);
    notifications = rows.rows.map((row) => ({
      notificationId: row.notification_id,
      recipientId: row.recipient_id,
      recipientRole: row.recipient_role,
      payload: row.payload,
      createdAt: row.created_at.toISOString(),
    }));
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  for (const notification of notifications) {
    await span('notification.signal', { 'notification.id': notification.notificationId, role: notification.recipientRole, 'auction.id': notification.payload.auctionSlug, outcome: 'persisted' }, async () => publisher.publish(notificationChannel, JSON.stringify({
      notificationId: notification.notificationId,
      recipientId: notification.recipientId,
      traceContext: currentCarrier(),
    })));
  }
  return notifications;
}
