ALTER TABLE bids
  ADD CONSTRAINT bids_close_reference_unique UNIQUE (auction_slug, id, bidder_id, amount_minor);

CREATE TABLE auction_closes (
  auction_slug text PRIMARY KEY REFERENCES auctions(slug),
  closed_at timestamptz NOT NULL,
  winning_bid_id bigint,
  winner_id text,
  winning_amount_minor integer,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT auction_closes_winner_fields_check CHECK (
    (winning_bid_id IS NULL AND winner_id IS NULL AND winning_amount_minor IS NULL)
    OR (winning_bid_id IS NOT NULL AND winner_id IS NOT NULL AND winning_amount_minor IS NOT NULL
      AND winning_amount_minor BETWEEN 1 AND 999999999)
  ),
  CONSTRAINT auction_closes_bid_matches_winner FOREIGN KEY
    (auction_slug, winning_bid_id, winner_id, winning_amount_minor)
    REFERENCES bids (auction_slug, id, bidder_id, amount_minor)
);

CREATE TABLE outbox_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_slug text NOT NULL REFERENCES auction_closes(auction_slug),
  event_type text NOT NULL CHECK (event_type = 'auction.closed'),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz,
  CONSTRAINT outbox_one_close_event_per_auction UNIQUE (auction_slug, event_type)
);

CREATE INDEX outbox_pending_events_idx ON outbox_events (created_at, event_id)
  WHERE published_at IS NULL;
