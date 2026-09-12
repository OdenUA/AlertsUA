-- Extend threat_vectors.threat_kind to include 'ballistic' and 'tactical_aviation'.
-- These represent high-priority threat categories that trigger the critical-threat
-- indicator on the Android client.

ALTER TABLE threat_vectors
  DROP CONSTRAINT IF EXISTS threat_vectors_threat_kind_check;

ALTER TABLE threat_vectors
  ADD CONSTRAINT threat_vectors_threat_kind_check
  CHECK (threat_kind IN ('uav', 'kab', 'missile', 'ballistic', 'tactical_aviation', 'unknown'));
