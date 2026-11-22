CREATE TABLE demo_users (
  id text PRIMARY KEY,
  display_name text NOT NULL UNIQUE CHECK (length(display_name) BETWEEN 1 AND 80),
  sort_order integer NOT NULL UNIQUE
);

INSERT INTO demo_users (id, display_name, sort_order) VALUES
('north-loop', 'North Loop Compute', 1),
('decommissioned-dreams', 'Decommissioned Dreams', 2),
('heap-and-sons', 'Heap & Sons', 3),
('bare-metal', 'Bare Metal Matchmakers', 4),
('layer-eight', 'Layer Eight Supply', 5),
('cool-story', 'Cool Story Systems', 6),
('alex-morgan', 'Alex Morgan', 7),
('sam-rivera', 'Sam Rivera', 8),
('jordan-lee', 'Jordan Lee', 9),
('taylor-reed', 'Taylor Reed', 10);

-- Preserve every original value before adopting USD semantics and demo identity.
ALTER TABLE auctions
  ADD COLUMN legacy_metadata jsonb,
  ADD COLUMN seller_id text REFERENCES demo_users(id),
  ADD COLUMN location text CHECK (length(location) BETWEEN 1 AND 200),
  ADD COLUMN currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD');

UPDATE auctions SET legacy_metadata = jsonb_build_object(
  'currency', 'INR', 'startingPriceMinor', starting_price_minor, 'seller', seller
);
UPDATE auctions a SET seller_id = u.id FROM demo_users u WHERE a.seller = u.display_name;
UPDATE auctions SET seller_id = 'alex-morgan' WHERE seller_id IS NULL;
UPDATE auctions a SET seller = u.display_name FROM demo_users u WHERE a.seller_id = u.id;
ALTER TABLE auctions ALTER COLUMN seller_id SET NOT NULL;

UPDATE auctions SET location = CASE slug
  WHEN 'nvidia-h100-sxm-80gb' THEN 'Minneapolis, MN'
  WHEN 'amd-epyc-9654' THEN 'Columbus, OH'
  WHEN 'one-point-five-tb-ddr5-ecc' THEN 'Ashburn, VA'
  WHEN 'supermicro-4u-gpu-chassis' THEN 'Chicago, IL'
  WHEN 'quantum-2-400g-switch' THEN 'Dallas, TX'
  WHEN 'direct-to-chip-cooling-loop' THEN 'Austin, TX'
  ELSE NULL END;
