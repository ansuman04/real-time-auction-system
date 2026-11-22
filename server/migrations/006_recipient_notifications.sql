CREATE TABLE recipient_notifications (
  notification_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES outbox_events(event_id),
  auction_slug text NOT NULL REFERENCES auction_closes(auction_slug),
  recipient_id text NOT NULL REFERENCES demo_users(id),
  recipient_role text NOT NULL CHECK (recipient_role IN ('seller','winner')),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  dismissed_at timestamptz,
  CONSTRAINT recipient_notifications_event_recipient_unique UNIQUE (event_id, recipient_id)
);

CREATE INDEX recipient_notifications_pending_idx
  ON recipient_notifications (recipient_id, created_at, notification_id)
  WHERE dismissed_at IS NULL;
