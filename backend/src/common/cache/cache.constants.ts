export const CACHE_KEYS = {
  ALERTS_CURRENT: 'alerts:current',
  THREATS_BUCKET: (ts: number) => `threats:${Math.floor(ts / 300000) * 300000}`,
  FEATURES: (layer: string, lod: string) => `features:${layer}:${lod}`,
  REGIONS_STATIC: 'regions:static',
  OBLAST_SIMPLIFIED: 'oblast:simplified',
} as const;

export const CACHE_TTL = {
  ALERTS: 75,
  THREATS: 8100,
  FEATURES: 3600,
  STATIC: 86400,
} as const;

export const CACHE_CHANNELS = {
  ALERTS_UPDATED: 'map:alerts:updated',
  THREATS_UPDATED: 'map:threats:updated',
} as const;
