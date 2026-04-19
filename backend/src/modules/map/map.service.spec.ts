import assert from 'node:assert/strict';
import test from 'node:test';
import { MapService } from './map.service';

test('getThreatOverlays keeps UAVs visible shortly after alert end and still enforces expiry', async () => {
  let capturedSql = '';
  let capturedValues: unknown[] = [];

  const fakeDatabaseService = {
    isConfigured: () => true,
    query: async (sql: string, values?: unknown[]) => {
      capturedSql = sql;
      capturedValues = values ?? [];
      return { rows: [] };
    },
  };

  const service = new MapService(fakeDatabaseService as never);
  const result = await service.getThreatOverlays();

  assert.equal(result.overlays.length, 0);
  assert.equal(capturedValues.length, 0);
  assert.match(capturedSql, /event_kind = 'ended'/);
  assert.match(capturedSql, /tv\.threat_kind = 'uav'/);
  assert.match(capturedSql, /last_end\.last_ended_at \+ INTERVAL '1 hour' > NOW\(\)/);
  assert.match(capturedSql, /COALESCE\(tv\.target_uid, tv\.origin_uid\) IS NOT NULL/);
  assert.match(capturedSql, /tv\.expires_at IS NULL OR tv\.expires_at > NOW\(\)/);
});

test('getThreatOverlays still applies bbox filtering when requested', async () => {
  let capturedSql = '';
  let capturedValues: unknown[] = [];

  const fakeDatabaseService = {
    isConfigured: () => true,
    query: async (sql: string, values?: unknown[]) => {
      capturedSql = sql;
      capturedValues = values ?? [];
      return { rows: [] };
    },
  };

  const service = new MapService(fakeDatabaseService as never);
  await service.getThreatOverlays('22,44,33,55');

  assert.equal(capturedValues.length, 4);
  assert.match(capturedSql, /ST_MakeEnvelope\(\$1, \$2, \$3, \$4, 4326\)/);
});