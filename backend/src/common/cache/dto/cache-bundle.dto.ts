export interface AlertsBundleDto {
  state_version: number;
  generated_at: string;
  active_alerts: {
    features: Array<{
      uid: number;
      title_uk: string;
      region_type: string;
      alert_type: string;
      geometry: any;
    }>;
    meta: { count: number };
  };
  oblast_aggregates: Record<
    number,
    { status: string; active_count: number; total_count: number }
  >;
}

export interface ThreatsBundleDto {
  bucket_ts: number;
  generated_at: string;
  expires_at: string;
  overlays: Array<{
    overlay_id: string;
    vector_id: string;
    threat_kind: string;
    confidence: number;
    movement_bearing_deg: number | null;
    icon_type: string;
    color_hex: string;
    occurred_at: string;
    expires_at: string | null;
    geometry: {
      marker?: any;
      corridor?: any;
      area?: any;
    };
  }>;
}

export interface FeaturesBundleDto {
  layer: string;
  lod: string;
  bbox?: string;
  generated_at: string;
  features: {
    geometries: Array<{
      uid: number;
      title_uk: string;
      region_type: string;
      parent_uid: number | null;
      oblast_uid: number | null;
      geometry: any;
    }>;
    status_lookup: Record<number, { status: string; alert_type: string }>;
  };
}
