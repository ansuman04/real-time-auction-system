ALTER TABLE outbox_events DROP CONSTRAINT outbox_events_event_type_check;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_event_type_check
  CHECK (event_type IN ('auction.closed', 'payment.paid'));

CREATE TABLE payment_deliveries (
  event_id uuid NOT NULL REFERENCES outbox_events(event_id),
  recipient_id text NOT NULL REFERENCES demo_users(id),
  auction_slug text NOT NULL REFERENCES auction_closes(auction_slug),
  PRIMARY KEY (event_id, recipient_id)
);

-- Provider-owned evidence survives removal of a hosted session. It is never
-- marketplace payment proof; it only prevents unsafe repeat collection.
CREATE TABLE mock_stripe_purchase_ledger (
  purchase_id uuid PRIMARY KEY,
  state jsonb NOT NULL
);
INSERT INTO mock_stripe_purchase_ledger (purchase_id,state)
  SELECT purchase_id,state FROM mock_stripe_sessions;
