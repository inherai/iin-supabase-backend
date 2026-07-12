-- Featured article: admin-selected article shown first in the feed-page articles widget.
-- Only one article should be featured at a time (enforced by the API endpoint).
ALTER TABLE articles ADD COLUMN IF NOT EXISTS is_featured boolean NOT NULL DEFAULT false;
