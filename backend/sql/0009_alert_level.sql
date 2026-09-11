-- Alert level (red/yellow) support.
-- alerts.in.ua /v1/alerts/active.json returns alert_level per active alert
-- (red = повітряна тривога, yellow = загроза). The IoT status string does not
-- carry the level, so the poll worker fetches the active alerts endpoint every
-- cycle and stores the level next to the status.

ALTER TABLE air_raid_state_current
ADD COLUMN IF NOT EXISTS alert_level TEXT NOT NULL DEFAULT 'red';

COMMENT ON COLUMN air_raid_state_current.alert_level IS 'Threat level from alerts.in.ua active.json: red | yellow (meaningful only while status is active)';

ALTER TABLE alert_layer_features
ADD COLUMN IF NOT EXISTS alert_level TEXT NOT NULL DEFAULT 'red';

COMMENT ON COLUMN alert_layer_features.alert_level IS 'Threat level (red | yellow) used by the map client to pick the fill color';

-- Raw IoT status string of the cycle, so a 304 response can still apply
-- attribute-only changes (alert_type / alert_level) from active.json.
ALTER TABLE alert_poll_cycles
ADD COLUMN IF NOT EXISTS status_string TEXT;

COMMENT ON COLUMN alert_poll_cycles.status_string IS 'Raw IoT status string received in this cycle (NULL for 304/error cycles)';
