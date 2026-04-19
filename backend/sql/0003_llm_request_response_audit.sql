-- LLM request/response audit log for telegram parser

CREATE TABLE IF NOT EXISTS llm_request_response_audit (
  audit_id UUID PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES llm_parse_jobs(job_id) ON DELETE CASCADE,
  attempt_count INTEGER NOT NULL,
  model TEXT NOT NULL,
  request_payload JSONB NOT NULL,
  response_status INTEGER NULL,
  response_body TEXT NOT NULL DEFAULT '',
  parsed_candidates JSONB NOT NULL DEFAULT '[]'::jsonb,
  error_text TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_llm_rr_audit_job_created
  ON llm_request_response_audit(job_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_llm_rr_audit_created
  ON llm_request_response_audit(created_at DESC);
