-- Extend threat_vectors.threat_kind to include 'banderol'.

ALTER TABLE threat_vectors
  DROP CONSTRAINT IF EXISTS threat_vectors_threat_kind_check;

ALTER TABLE threat_vectors
  ADD CONSTRAINT threat_vectors_threat_kind_check
  CHECK (threat_kind IN ('uav', 'banderol', 'kab', 'missile', 'ballistic', 'tactical_aviation', 'unknown'));
