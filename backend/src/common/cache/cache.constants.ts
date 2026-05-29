export const CACHE_KEYS = {
  ALERTS_CURRENT: 'alerts:current',
  ALERTS_LAYER: 'alerts:layer:response',
  ALERTS_ACTIVE_UIDS: 'alerts:active:uids',
  MAP_BUNDLE: 'map:bundle',
  THREAT_BUNDLE: 'map:threat-bundle',
  THREATS_BUCKET: (ts: number) => `threats:${Math.floor(ts / 60000) * 60000}`,
  FEATURES: (layer: string, lod: string) => `features:${layer}:${lod}`,
  REGIONS_STATIC: 'regions:static',
  OBLAST_SIMPLIFIED: 'oblast:simplified',
} as const;

export const CACHE_TTL = {
  ALERTS: 75,
  MAP_BUNDLE: 120,
  THREAT_BUNDLE: 60,
  THREATS: 60,
  FEATURES: 3600,
  STATIC: 86400,
} as const;

export const CACHE_CHANNELS = {
  ALERTS_UPDATED: 'map:alerts:updated',
  THREATS_UPDATED: 'map:threats:updated',
} as const;
