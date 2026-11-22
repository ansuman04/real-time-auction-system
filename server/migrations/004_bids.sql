CREATE TABLE bids (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  auction_slug text NOT NULL REFERENCES auctions(slug),
  bidder_id text NOT NULL REFERENCES demo_users(id),
  amount_minor integer NOT NULL CHECK (amount_minor BETWEEN 1 AND 999999999),
  accepted_at timestamptz NOT NULL
);
CREATE INDEX bids_auction_order_idx ON bids (auction_slug, id DESC);
