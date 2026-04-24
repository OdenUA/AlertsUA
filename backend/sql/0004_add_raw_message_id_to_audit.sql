-- Add raw_message_id column to llm_request_response_audit for easier debugging and analysis

ALTER TABLE llm_request_response_audit
ADD COLUMN IF NOT EXISTS raw_message_id TEXT;

-- Add index for faster lookups by raw_message_id
CREATE INDEX IF NOT EXISTS idx_llm_rr_audit_raw_message_id
ON llm_request_response_audit(raw_message_id);

-- Add comment to document the new column
COMMENT ON COLUMN llm_request_response_audit.raw_message_id IS 'Raw Telegram message ID from telegram_messages_raw table for easier debugging and analysis';
