CREATE TABLE purchases (
  id uuid PRIMARY KEY,
  auction_slug text NOT NULL UNIQUE REFERENCES auction_closes(auction_slug),
  buyer_id text NOT NULL REFERENCES demo_users(id),
  amount_minor integer NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL DEFAULT 'usd' CHECK (currency = 'usd'),
  title text NOT NULL,
  success_url text NOT NULL,
  cancel_url text NOT NULL,
  session_id text UNIQUE,
  checkout_url text,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payment_webhook_receipts (
  event_id uuid PRIMARY KEY,
  purchase_id uuid NOT NULL REFERENCES purchases(id),
  payload_hash text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- Local payment-provider simulator state is independent of marketplace paid state.
CREATE TABLE mock_stripe_sessions (
  id text PRIMARY KEY,
  purchase_id uuid NOT NULL UNIQUE,
  state jsonb NOT NULL
);
