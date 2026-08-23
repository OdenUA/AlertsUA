-- Add source_excerpt column to threat_vectors for per-threat message fragments
-- When one Telegram message describes several threats, each vector stores only
-- the verbatim quote of the fragment that describes it. The API serves this
-- excerpt instead of the full message text; clients fall back to message_text
-- when source_excerpt is NULL (older rows).

ALTER TABLE threat_vectors
ADD COLUMN IF NOT EXISTS source_excerpt TEXT;

COMMENT ON COLUMN threat_vectors.source_excerpt IS 'Verbatim quote of the part of the source Telegram message that describes this specific threat (NULL = show full message text)';
