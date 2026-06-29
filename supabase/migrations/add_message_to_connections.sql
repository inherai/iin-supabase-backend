-- Add optional personal note to connection requests
ALTER TABLE connections ADD COLUMN IF NOT EXISTS message TEXT;

ALTER TABLE connections
  ADD CONSTRAINT connections_message_length
  CHECK (message IS NULL OR char_length(message) <= 300);
