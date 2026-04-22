import assert from 'node:assert/strict';
import test from 'node:test';
import { MapService } from './map.service';

test('getThreatOverlays keeps anchored threats visible briefly before any alert end, then hides them after the first end', async () => {
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
  const anchoredBranchMatch = capturedSql.match(
    /COALESCE\(tv\.target_uid, tv\.origin_uid\) IS NOT NULL([\s\S]*?)OR \(\s*COALESCE\(tv\.target_uid, tv\.origin_uid\) IS NULL/,
  );

  assert.equal(result.overlays.length, 0);
  assert.equal(capturedValues.length, 0);
  assert.ok(anchoredBranchMatch);
  assert.match(capturedSql, /event_kind = 'ended'/);
  assert.match(capturedSql, /e\.occurred_at >= tv\.occurred_at/);
  assert.match(capturedSql, /tv\.occurred_at \+ INTERVAL '2 hours' > NOW\(\)/);
  assert.match(capturedSql, /tv\.occurred_at \+ INTERVAL '1 hour' > NOW\(\)/);
  assert.match(capturedSql, /COALESCE\(tv\.target_uid, tv\.origin_uid\) IS NOT NULL/);
  assert.match(capturedSql, /COALESCE\(tv\.expires_at, tv\.occurred_at \+ INTERVAL '2 hours'\) > NOW\(\)/);
  assert.match(capturedSql, /arc_raion\.status IN \('A', 'P'\)/);
  assert.match(capturedSql, /ended_since_occurrence\.first_ended_at IS NULL/);
  assert.doesNotMatch(anchoredBranchMatch[1], /tv\.expires_at/);
  assert.doesNotMatch(capturedSql, /tv\.threat_kind = 'uav'/);
  assert.doesNotMatch(capturedSql, /last_end\.last_ended_at \+ INTERVAL '1 hour' > NOW\(\)/);
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

test('getThreatOverlays derives a bearing from the corridor when stored bearing is a default zero', async () => {
  const fakeDatabaseService = {
    isConfigured: () => true,
    query: async () => ({
      rows: [
        {
          overlay_id: 'overlay-1',
          vector_id: 'vector-1',
          threat_kind: 'uav',
          confidence: 0.9,
          movement_bearing_deg: 0,
          icon_type: 'uav',
          color_hex: '#000000',
          occurred_at: '2026-04-20T10:00:00.000Z',
          expires_at: '2026-04-20T12:00:00.000Z',
          message_text: 'Тестове повідомлення',
          message_date: '2026-04-20T10:00:00.000Z',
          marker_json: null,
          corridor_json: JSON.stringify({
            type: 'LineString',
            coordinates: [
              [30, 50],
              [30, 49],
            ],
          }),
          area_json: null,
        },
      ],
    }),
  };

  const service = new MapService(fakeDatabaseService as never);
  const result = await service.getThreatOverlays();

  assert.equal(result.overlays.length, 1);
  assert.equal(result.overlays[0]?.movement_bearing_deg, 180);
});