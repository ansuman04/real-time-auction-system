CREATE TABLE auctions (
  slug text PRIMARY KEY,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 5000),
  category text NOT NULL CHECK (category IN ('GPUs','CPUs','Memory','Chassis','Networking','Cooling','Other')),
  condition text NOT NULL CHECK (length(condition) BETWEEN 1 AND 100),
  seller text NOT NULL CHECK (length(seller) BETWEEN 1 AND 80),
  starting_price_minor integer NOT NULL CHECK (starting_price_minor > 0),
  ends_at timestamptz NOT NULL,
  art text NOT NULL CHECK (art IN ('gpu','cpu','memory','chassis','switch','cooling')),
  specs jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auctions_created_at_idx ON auctions (created_at DESC, slug);
