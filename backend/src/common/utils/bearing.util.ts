export function normalizeBearingDegrees(value: unknown) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  const normalized = parsed % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

export function calculateBearingDegrees(lat1: number, lon1: number, lat2: number, lon2: number) {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const toDeg = (value: number) => (value * 180) / Math.PI;

  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const deltaLambda = toRad(lon2 - lon1);

  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);

  const theta = toDeg(Math.atan2(y, x));
  return (theta + 360) % 360;
}

export function getBearingDeltaDegrees(first: number, second: number) {
  const normalizedFirst = normalizeBearingDegrees(first);
  const normalizedSecond = normalizeBearingDegrees(second);

  if (normalizedFirst === null || normalizedSecond === null) {
    return null;
  }

  const difference = Math.abs(normalizedFirst - normalizedSecond) % 360;
  return difference > 180 ? 360 - difference : difference;
}

export function resolveMovementBearingDegrees(
  explicitBearing: number | null | undefined,
  derivedBearing: number | null | undefined,
  zeroFallbackToleranceDegrees = 1,
) {
  const normalizedExplicit =
    explicitBearing === null || explicitBearing === undefined
      ? null
      : normalizeBearingDegrees(explicitBearing);
  const normalizedDerived =
    derivedBearing === null || derivedBearing === undefined ? null : normalizeBearingDegrees(derivedBearing);

  if (normalizedExplicit === null) {
    return normalizedDerived;
  }

  if (normalizedDerived === null) {
    return normalizedExplicit;
  }

  const delta = getBearingDeltaDegrees(normalizedExplicit, normalizedDerived);
  if (normalizedExplicit === 0 && delta !== null && delta > zeroFallbackToleranceDegrees) {
    return normalizedDerived;
  }

  return normalizedExplicit;
}
