-- Diagnostic context is optional; existing records and business constraints remain valid.
ALTER TABLE bids ADD COLUMN trace_context jsonb;
ALTER TABLE auction_closes ADD COLUMN trace_context jsonb;
ALTER TABLE outbox_events ADD COLUMN trace_context jsonb;
ALTER TABLE purchases ADD COLUMN trace_context jsonb;
ALTER TABLE recipient_notifications ADD COLUMN trace_context jsonb;
