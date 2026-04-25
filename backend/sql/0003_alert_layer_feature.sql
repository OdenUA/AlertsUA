-- Precomputed alert layer for fast map rendering
-- This table stores a single unified layer of all regions with active alerts
-- Updated on every alert status change

CREATE TABLE IF NOT EXISTS alert_layer_features (
    feature_id SERIAL PRIMARY KEY,
    uid INTEGER NOT NULL REFERENCES region_catalog(uid) ON DELETE CASCADE,
    region_type TEXT NOT NULL CHECK (region_type IN ('oblast', 'city', 'raion', 'hromada')),
    alert_type TEXT NOT NULL DEFAULT 'air_raid',
    geometry_json TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_alert_layer_features_uid ON alert_layer_features(uid);
CREATE INDEX IF NOT EXISTS idx_alert_layer_features_type ON alert_layer_features(region_type);

-- Trigger to update updated_at on modification
CREATE OR REPLACE FUNCTION update_alert_layer_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_alert_layer_features_updated_at
    BEFORE UPDATE ON alert_layer_features
    FOR EACH ROW
    EXECUTE FUNCTION update_alert_layer_updated_at();
