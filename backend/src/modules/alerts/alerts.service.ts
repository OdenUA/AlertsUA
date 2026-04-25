import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../common/database/database.service';
import { SupabaseSyncService } from '../supabase/supabase-sync.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { TimeUtil } from '../../common/utils/time.util';
import { CacheService } from '../../common/cache/cache.service';
import { CACHE_KEYS, CACHE_TTL, CACHE_CHANNELS } from '../../common/cache/cache.constants';
import type { AlertsBundleDto } from '../../common/cache/dto/cache-bundle.dto';

type AlertStatus = 'A' | 'P' | 'N' | ' ';
type AlertType = 'air_raid' | 'artillery_shelling' | 'urban_fights' | 'chemical' | 'nuclear';

type PollMetadata = {
  last_modified: string | null;
  status_string_hash: string | null;
  state_version: number;
};

type CurrentStateRow = {
  uid: number;
  status: AlertStatus;
  state_version: number;
  active_from: string | null;
  alert_type: AlertType;
  updated_at: string;
};

type AppliedSnapshot = {
  state_version: number;
  bootstrap_mode: boolean;
  changed_uids: number[];
  inserted_events: number;
  queued_dispatches: number;
};

const ALERTS_IN_UA_STATUS_ENDPOINT =
  'https://api.alerts.in.ua/v1/iot/active_air_raid_alerts.json';

const ALERTS_IN_UA_ACTIVE_ENDPOINT =
  'https://api.alerts.in.ua/v1/alerts/active.json';

const VALID_ALERT_TYPES = new Set<AlertType>([
  'air_raid',
  'artillery_shelling',
  'urban_fights',
  'chemical',
  'nuclear',
]);

const ACTIVE_STATUSES = new Set<AlertStatus>(['A', 'P']);
const VALID_STATUSES = new Set<AlertStatus>(['A', 'P', 'N', ' ']);

@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly databaseService: DatabaseService,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly supabaseSyncService: SupabaseSyncService,
    private readonly cacheService: CacheService,
  ) {}

  async getFullStatuses() {
    if (!this.databaseService.isConfigured()) {
      return {
        state_version: 0,
        generated_at: TimeUtil.getNowInKyiv(),
        source_last_modified: null,
        status_string: '',
        note_uk: 'База даних ще не підключена. Realtime-статуси недоступні.',
      };
    }

    const [maxUidResult, stateRowsResult, sourceMetaResult] = await Promise.all([
      this.databaseService.query<{ max_uid: number }>(
        'SELECT COALESCE(MAX(uid), 0) AS max_uid FROM region_catalog WHERE is_active = TRUE',
      ),
      this.databaseService.query<CurrentStateRow>(
        `
          SELECT uid, status, state_version, active_from, updated_at::text
          FROM air_raid_state_current
          ORDER BY uid ASC
        `,
      ),
      this.databaseService.query<{
        source_last_modified: string | null;
        generated_at: string | null;
      }>(
        `
          SELECT last_modified_received AS source_last_modified,
                 finished_at::text AS generated_at
          FROM alert_poll_cycles
          WHERE http_status IN (200, 304)
          ORDER BY cycle_id DESC
          LIMIT 1
        `,
      ),
    ]);

    if (stateRowsResult.rowCount === 0) {
      return {
        state_version: 0,
        generated_at: TimeUtil.getNowInKyiv(),
        source_last_modified: sourceMetaResult.rows[0]?.source_last_modified ?? null,
        status_string: '',
        note_uk: 'Realtime polling ще не виконувався. Дані зʼявляться після першого циклу опитування.',
      };
    }

    const maxUid = maxUidResult.rows[0]?.max_uid ?? 0;
    const statusString = this.buildStatusString(maxUid, stateRowsResult.rows);
    const latestStateVersion = stateRowsResult.rows.reduce(
      (maxVersion, row) => Math.max(maxVersion, Number(row.state_version)),
      0,
    );
    const generatedAt =
      sourceMetaResult.rows[0]?.generated_at ??
      stateRowsResult.rows.reduce(
        (latest, row) => (latest > row.updated_at ? latest : row.updated_at),
        stateRowsResult.rows[0].updated_at,
      );

    return {
      state_version: latestStateVersion,
      generated_at: generatedAt,
      source_last_modified: sourceMetaResult.rows[0]?.source_last_modified ?? null,
      status_string: statusString,
    };
  }

  async getDeltaStatuses(sinceVersion: number) {
    if (!this.databaseService.isConfigured()) {
      return {
        from_version: sinceVersion,
        to_version: sinceVersion,
        changes: [],
      };
    }

    const currentVersionResult = await this.databaseService.query<{ state_version: number }>(
      'SELECT COALESCE(MAX(state_version), 0) AS state_version FROM air_raid_state_current',
    );
    const currentVersion = Number(currentVersionResult.rows[0]?.state_version ?? 0);

    if (currentVersion <= sinceVersion) {
      return {
        from_version: sinceVersion,
        to_version: currentVersion,
        changes: [],
      };
    }

    const changesResult = await this.databaseService.query<{
      uid: number;
      status: AlertStatus;
      changed_at: string;
      state_version: number;
    }>(
      `
        SELECT uid,
               new_status AS status,
               occurred_at::text AS changed_at,
               state_version
        FROM air_raid_events
        WHERE state_version > $1
        ORDER BY state_version ASC, occurred_at ASC, uid ASC
      `,
      [sinceVersion],
    );

    return {
      from_version: sinceVersion,
      to_version: currentVersion,
      changes: changesResult.rows.map((row) => ({
        uid: row.uid,
        status: row.status,
        changed_at: row.changed_at,
        state_version: Number(row.state_version),
      })),
    };
  }

  async runPollCycle() {
    if (!this.databaseService.isConfigured()) {
      throw new Error('DATABASE_URL is not configured. Polling cannot start.');
    }

    const apiToken = this.configService.get<string>('ALERTS_IN_UA_TOKEN');
    if (!apiToken) {
      throw new Error('ALERTS_IN_UA_TOKEN is not configured.');
    }

    const requestedAt = new Date();
    const previousMetadata = await this.getLatestPollMetadata();

    let response: Response;
    try {
      response = await fetch(ALERTS_IN_UA_STATUS_ENDPOINT, {
        headers: {
          Authorization: `Bearer ${apiToken}`,
          Accept: 'application/json',
          ...(previousMetadata.last_modified
            ? { 'If-Modified-Since': previousMetadata.last_modified }
            : {}),
        },
        signal: AbortSignal.timeout(15000),
      });
    } catch (error) {
      const cycleId = await this.insertPollCycle({
        requested_at: requestedAt,
        finished_at: new Date(),
        http_status: 0,
        if_modified_since_sent: previousMetadata.last_modified,
        last_modified_received: previousMetadata.last_modified,
        status_string_hash: null,
        changed: false,
        error_code: 'FETCH_FAILED',
        error_message: this.stringifyError(error),
      });

      return {
        cycle_id: cycleId,
        http_status: 0,
        changed: false,
        error_code: 'FETCH_FAILED',
        error_message: this.stringifyError(error),
      };
    }

    const finishedAt = new Date();
    const httpStatus = response.status;
    const lastModifiedReceived = response.headers.get('last-modified');
    const responseBody = await response.text();

    if (httpStatus === 304) {
      // Refresh cache even when API returns 304 to prevent expiration
      try {
        await this.databaseService.withTransaction(async (client) => {
          const bundle = await this.buildAlertsBundle(client, previousMetadata.state_version);
          await this.cacheService.set(CACHE_KEYS.ALERTS_CURRENT, bundle, CACHE_TTL.ALERTS);
          this.logger.log(`Alerts cache refreshed (304 response): state_version=${previousMetadata.state_version}`);
        });
      } catch (error) {
        this.logger.error(`Failed to refresh alerts cache on 304: ${error}`);
      }

      const cycleId = await this.insertPollCycle({
        requested_at: requestedAt,
        finished_at: finishedAt,
        http_status: httpStatus,
        if_modified_since_sent: previousMetadata.last_modified,
        last_modified_received: lastModifiedReceived ?? previousMetadata.last_modified,
        status_string_hash: previousMetadata.status_string_hash,
        changed: false,
        error_code: null,
        error_message: null,
      });

      return {
        cycle_id: cycleId,
        http_status: httpStatus,
        changed: false,
        state_version: previousMetadata.state_version,
        inserted_events: 0,
        queued_dispatches: 0,
      };
    }

    if (httpStatus !== 200) {
      const cycleId = await this.insertPollCycle({
        requested_at: requestedAt,
        finished_at: finishedAt,
        http_status: httpStatus,
        if_modified_since_sent: previousMetadata.last_modified,
        last_modified_received: lastModifiedReceived ?? previousMetadata.last_modified,
        status_string_hash: null,
        changed: false,
        error_code: this.mapHttpStatusToErrorCode(httpStatus),
        error_message: this.extractErrorMessage(responseBody),
      });

      return {
        cycle_id: cycleId,
        http_status: httpStatus,
        changed: false,
        error_code: this.mapHttpStatusToErrorCode(httpStatus),
        error_message: this.extractErrorMessage(responseBody),
      };
    }

    const statusString = this.parseStatusString(responseBody);
    const statusStringHash = createHash('sha256').update(statusString).digest('hex');
    const sourceChanged = previousMetadata.status_string_hash !== statusStringHash;
    const cycleId = await this.insertPollCycle({
      requested_at: requestedAt,
      finished_at: finishedAt,
      http_status: httpStatus,
      if_modified_since_sent: previousMetadata.last_modified,
      last_modified_received: lastModifiedReceived ?? previousMetadata.last_modified,
      status_string_hash: statusStringHash,
      changed: sourceChanged,
      error_code: null,
      error_message: null,
    });

    if (!sourceChanged) {
      // Refresh cache even when no changes detected to prevent expiration
      try {
        await this.databaseService.withTransaction(async (client) => {
          const bundle = await this.buildAlertsBundle(client, previousMetadata.state_version);
          await this.cacheService.set(CACHE_KEYS.ALERTS_CURRENT, bundle, CACHE_TTL.ALERTS);
          this.logger.log(`Alerts cache refreshed (no changes): state_version=${previousMetadata.state_version}`);
        });
      } catch (error) {
        this.logger.error(`Failed to refresh alerts cache: ${error}`);
      }

      return {
        cycle_id: cycleId,
        http_status: httpStatus,
        changed: false,
        state_version: previousMetadata.state_version,
        inserted_events: 0,
        queued_dispatches: 0,
      };
    }

    try {
      const alertTypeMap = await this.fetchAlertTypeMap();
      const appliedSnapshot = await this.databaseService.withTransaction((client) =>
        this.applyStatusSnapshot(client, {
          cycle_id: cycleId,
          occurred_at: finishedAt,
          status_string: statusString,
          alert_type_map: alertTypeMap,
        }),
      );

      return {
        cycle_id: cycleId,
        http_status: httpStatus,
        changed: true,
        state_version: appliedSnapshot.state_version,
        bootstrap_mode: appliedSnapshot.bootstrap_mode,
        changed_uids: appliedSnapshot.changed_uids.length,
        inserted_events: appliedSnapshot.inserted_events,
        queued_dispatches: appliedSnapshot.queued_dispatches,
      };
    } catch (error) {
      await this.databaseService.query(
        `
          UPDATE alert_poll_cycles
          SET changed = FALSE,
              error_code = $2,
              error_message = $3
          WHERE cycle_id = $1
        `,
        [cycleId, 'PROCESSING_FAILED', this.stringifyError(error)],
      );
      throw error;
    }
  }

  private async getLatestPollMetadata(): Promise<PollMetadata> {
    const [lastCycleResult, stateVersionResult] = await Promise.all([
      this.databaseService.query<{
        last_modified: string | null;
        status_string_hash: string | null;
      }>(
        `
          SELECT last_modified_received AS last_modified,
                 status_string_hash
          FROM alert_poll_cycles
          ORDER BY cycle_id DESC
          LIMIT 1
        `,
      ),
      this.databaseService.query<{ state_version: number }>(
        'SELECT COALESCE(MAX(state_version), 0) AS state_version FROM air_raid_state_current',
      ),
    ]);

    return {
      last_modified: lastCycleResult.rows[0]?.last_modified ?? null,
      status_string_hash: lastCycleResult.rows[0]?.status_string_hash ?? null,
      state_version: Number(stateVersionResult.rows[0]?.state_version ?? 0),
    };
  }

  private async insertPollCycle(input: {
    requested_at: Date;
    finished_at: Date;
    http_status: number;
    if_modified_since_sent: string | null;
    last_modified_received: string | null;
    status_string_hash: string | null;
    changed: boolean;
    error_code: string | null;
    error_message: string | null;
  }) {
    const result = await this.databaseService.query<{ cycle_id: number }>(
      `
        INSERT INTO alert_poll_cycles (
          requested_at,
          finished_at,
          http_status,
          if_modified_since_sent,
          last_modified_received,
          status_string_hash,
          changed,
          error_code,
          error_message
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING cycle_id
      `,
      [
        input.requested_at.toISOString(),
        input.finished_at.toISOString(),
        input.http_status,
        input.if_modified_since_sent,
        input.last_modified_received,
        input.status_string_hash,
        input.changed,
        input.error_code,
        input.error_message,
      ],
    );

    return Number(result.rows[0].cycle_id);
  }

  private async fetchAlertTypeMap(): Promise<Map<number, AlertType>> {
    const apiToken = this.configService.get<string>('ALERTS_IN_UA_TOKEN');
    if (!apiToken) {
      return new Map();
    }

    try {
      const response = await fetch(ALERTS_IN_UA_ACTIVE_ENDPOINT, {
        headers: {
          Authorization: `Bearer ${apiToken}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        return new Map();
      }

      const body = await response.json() as {
        alerts?: Array<{ location_uid?: string; alert_type?: string }>;
      };
      const map = new Map<number, AlertType>();

      for (const alert of body.alerts ?? []) {
        const uid = Number(alert.location_uid);
        const alertType = alert.alert_type;
        if (Number.isFinite(uid) && uid > 0 && alertType && VALID_ALERT_TYPES.has(alertType as AlertType)) {
          // air_raid takes priority over other types for the same region
          if (!map.has(uid) || map.get(uid) !== 'air_raid') {
            map.set(uid, alertType as AlertType);
          }
        }
      }

      return map;
    } catch {
      return new Map();
    }
  }

  private async buildAlertsBundle(
    client: PoolClient,
    stateVersion: number,
  ): Promise<AlertsBundleDto> {
    const [activeAlertsResult, oblastAggregatesResult] = await Promise.all([
      client.query<{
        uid: number;
        title_uk: string;
        region_type: string;
        alert_type: string;
        geometry_json: string;
      }>(
        `
          -- Get subscription_leaf regions with alerts (hromadas, cities)
          SELECT rc.uid, rc.title_uk, rc.region_type, arc.alert_type,
                 COALESCE(ST_AsGeoJSON(rg.geom)::text, ST_AsGeoJSON(rgl.geom)::text) AS geometry_json
          FROM air_raid_state_current arc
          JOIN region_catalog rc ON rc.uid = arc.uid AND rc.is_subscription_leaf = TRUE
          JOIN region_geometry rg ON rg.uid = rc.uid
          LEFT JOIN region_geometry_lod rgl ON rgl.uid = rc.uid AND rgl.lod = 'low'
          WHERE arc.status = ANY(ARRAY['A'::text, 'P'::text])

          UNION ALL

          -- Get raions that have children with alerts
          SELECT DISTINCT rc.uid, rc.title_uk, rc.region_type,
                 COALESCE(par.alert_type, 'air_raid') AS alert_type,
                 COALESCE(ST_AsGeoJSON(rg.geom)::text, ST_AsGeoJSON(rgl.geom)::text) AS geometry_json
          FROM air_raid_state_current arc
          JOIN region_catalog child ON child.uid = arc.uid AND child.is_subscription_leaf = TRUE
          JOIN region_catalog rc ON rc.uid = child.parent_uid AND rc.region_type = 'raion'
          JOIN region_geometry rg ON rg.uid = rc.uid
          LEFT JOIN region_geometry_lod rgl ON rgl.uid = rc.uid AND rgl.lod = 'low'
          LEFT JOIN air_raid_state_current par ON par.uid = rc.uid
          WHERE arc.status = ANY(ARRAY['A'::text, 'P'::text])
        `,
      ),
      client.query<{
        oblast_uid: number;
        status: string;
        active_count: number;
        total_count: number;
      }>(
        `
          WITH oblast_regions AS (
            SELECT rc.oblast_uid, arc.status
            FROM region_catalog rc
            LEFT JOIN air_raid_state_current arc ON arc.uid = rc.uid
            WHERE rc.is_active = TRUE AND rc.is_subscription_leaf = TRUE
          )
          SELECT oblast_uid,
                 CASE WHEN COUNT(*) FILTER (WHERE status = ANY(ARRAY['A'::text, 'P'::text])) > 0 THEN 'A'
                      WHEN COUNT(*) FILTER (WHERE status = 'N') > 0 THEN 'N'
                      ELSE ' ' END AS status,
                 COUNT(*) FILTER (WHERE status = ANY(ARRAY['A'::text, 'P'::text]))::int AS active_count,
                 COUNT(*)::int AS total_count
          FROM oblast_regions
          WHERE oblast_uid IS NOT NULL
          GROUP BY oblast_uid
        `,
      ),
    ]);

    const activeAlerts = activeAlertsResult.rows.map((row) => ({
      uid: row.uid,
      title_uk: row.title_uk,
      region_type: row.region_type,
      alert_type: row.alert_type,
      geometry: JSON.parse(row.geometry_json),
    }));

    const oblastAggregates: Record<number, { status: string; active_count: number; total_count: number }> = {};
    for (const row of oblastAggregatesResult.rows) {
      oblastAggregates[row.oblast_uid] = {
        status: row.status,
        active_count: row.active_count,
        total_count: row.total_count,
      };
    }

    return {
      state_version: stateVersion,
      generated_at: TimeUtil.getNowInKyiv(),
      active_alerts: {
        features: activeAlerts,
        meta: { count: activeAlerts.length },
      },
      oblast_aggregates: oblastAggregates,
    };
  }

  private async applyStatusSnapshot(
    client: PoolClient,
    input: {
      cycle_id: number;
      occurred_at: Date;
      status_string: string;
      alert_type_map: Map<number, AlertType>;
    },
  ): Promise<AppliedSnapshot> {
    const [regionRowsResult, currentRowsResult, stateVersionResult] = await Promise.all([
      client.query<{ uid: number }>(
        'SELECT uid, oblast_uid FROM region_catalog WHERE is_active = TRUE ORDER BY uid ASC',
      ),
      client.query<{
        uid: number;
        status: AlertStatus;
        state_version: number;
        active_from: string | null;
        alert_type: AlertType;
      }>(
        `
          SELECT uid, status, state_version, active_from::text, alert_type
          FROM air_raid_state_current
          FOR UPDATE
        `,
      ),
      client.query<{ state_version: number }>(
        'SELECT COALESCE(MAX(state_version), 0) AS state_version FROM air_raid_state_current',
      ),
    ]);

    if (regionRowsResult.rowCount === 0) {
      throw new Error('region_catalog is empty. Import regions before running the poller.');
    }

    const currentAlertTypeMap = input.alert_type_map;

    const previousStates = new Map(
      currentRowsResult.rows.map((row) => [row.uid, row]),
    );
    const bootstrapMode = currentRowsResult.rowCount === 0;
    const previousStateVersion = Number(stateVersionResult.rows[0]?.state_version ?? 0);
    const changedRows: Array<{
      uid: number;
      previous_status: AlertStatus;
      new_status: AlertStatus;
      active_from: string | null;
      alert_type: AlertType;
    }> = [];

    const nextRows = (regionRowsResult.rows as Array<{ uid: number; oblast_uid: number | null }>).map(({ uid }) => {
      const previousState = previousStates.get(uid);
      const previousStatus = previousState?.status ?? ' ';
      let newStatus = this.statusAtUid(input.status_string, uid);

      // The IoT string only tracks air_raid status. For other alert types
      // we trust the active alerts endpoint only for the same uid.
      if (newStatus !== 'A' && currentAlertTypeMap.has(uid)) {
        newStatus = 'A';
      }

      const activeFrom = this.resolveActiveFrom(
        previousState?.active_from ?? null,
        previousStatus,
        newStatus,
        input.occurred_at,
      );

      if (previousStatus !== newStatus) {
        const changedAlertType = currentAlertTypeMap.get(uid)
          ?? previousState?.alert_type
          ?? 'air_raid';
        changedRows.push({
          uid,
          previous_status: previousStatus,
          new_status: newStatus,
          active_from: activeFrom,
          alert_type: changedAlertType,
        });
      }

      const alertType = currentAlertTypeMap.get(uid)
        ?? previousState?.alert_type
        ?? 'air_raid';

      return {
        uid,
        status: newStatus,
        active_from: activeFrom,
        alert_type: alertType,
      };
    });

    if (!bootstrapMode && changedRows.length === 0) {
      // Even if no changes, always update the cache to prevent it from expiring
      try {
        const bundle = await this.buildAlertsBundle(client, previousStateVersion);
        await this.cacheService.set(CACHE_KEYS.ALERTS_CURRENT, bundle, CACHE_TTL.ALERTS);
        this.logger.log(`Alerts cache refreshed (no changes): state_version=${previousStateVersion}`);
      } catch (error) {
        this.logger.error(`Failed to update alerts cache: ${error}`);
      }

      return {
        state_version: previousStateVersion,
        bootstrap_mode: false,
        changed_uids: [],
        inserted_events: 0,
        queued_dispatches: 0,
      };
    }

    const nextStateVersion = previousStateVersion + 1;
    for (const row of nextRows) {
      await client.query(
        `
          INSERT INTO air_raid_state_current (
            uid,
            status,
            state_version,
            active_from,
            updated_at,
            source_cycle_id,
            alert_type
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (uid) DO UPDATE SET
            status = EXCLUDED.status,
            state_version = EXCLUDED.state_version,
            active_from = EXCLUDED.active_from,
            updated_at = EXCLUDED.updated_at,
            source_cycle_id = EXCLUDED.source_cycle_id,
            alert_type = EXCLUDED.alert_type
        `,
        [
          row.uid,
          row.status,
          nextStateVersion,
          row.active_from,
          input.occurred_at.toISOString(),
          input.cycle_id,
          row.alert_type,
        ],
      );
    }

    let insertedEvents = 0;
    if (!bootstrapMode) {
      for (const row of changedRows) {
        const eventId = randomUUID();
        const eventKind = this.resolveEventKind(row.previous_status, row.new_status);
        const eventResult = await client.query(
          `
            INSERT INTO air_raid_events (
              event_id,
              uid,
              event_kind,
              previous_status,
              new_status,
              alert_type,
              state_version,
              source_cycle_id,
              occurred_at,
              dedupe_key,
              created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW() AT TIME ZONE 'Europe/Kyiv')
            ON CONFLICT (dedupe_key) DO NOTHING
          `,
          [
            eventId,
            row.uid,
            eventKind,
            row.previous_status,
            row.new_status,
            row.alert_type,
            nextStateVersion,
            input.cycle_id,
            input.occurred_at.toISOString(),
            `${row.uid}:${nextStateVersion}:${row.previous_status}:${row.new_status}`,
          ],
        );

        if ((eventResult.rowCount ?? 0) > 0) {
          insertedEvents += 1;
          await this.supabaseSyncService.enqueueEntity(client, {
            entity_type: 'alert_event_log',
            entity_id: eventId,
            operation: 'insert',
            payload: {
              event_id: eventId,
              uid: row.uid,
              event_kind: eventKind,
              previous_status: row.previous_status,
              new_status: row.new_status,
              state_version: nextStateVersion,
              occurred_at: input.occurred_at.toISOString(),
              created_at: input.occurred_at.toISOString(),
            },
          });
        }
      }
    }

    const runtimeResult = await this.subscriptionsService.synchronizeRuntimeState(client, {
      state_version: nextStateVersion,
      occurred_at: input.occurred_at,
    });

    // Invalidate and rebuild alerts cache
    try {
      const bundle = await this.buildAlertsBundle(client, nextStateVersion);
      await this.cacheService.set(CACHE_KEYS.ALERTS_CURRENT, bundle, CACHE_TTL.ALERTS);
      await this.cacheService.publish(CACHE_CHANNELS.ALERTS_UPDATED, {
        state_version: nextStateVersion,
        changed_uids: changedRows.map((row) => row.uid),
      });
      this.logger.log(`Alerts cache updated: state_version=${nextStateVersion}, count=${bundle.active_alerts.meta.count}`);
    } catch (error) {
      this.logger.error(`Failed to update alerts cache: ${error}`);
      if (error instanceof Error) {
        this.logger.error(`Cache error stack: ${error.stack}`);
      }
    }

    return {
      state_version: nextStateVersion,
      bootstrap_mode: bootstrapMode,
      changed_uids: changedRows.map((row) => row.uid),
      inserted_events: insertedEvents,
      queued_dispatches: runtimeResult.queued_dispatches,
    };
  }

  private buildStatusString(maxUid: number, stateRows: CurrentStateRow[]) {
    const buffer = Array.from({ length: maxUid + 1 }, () => ' ');
    for (const row of stateRows) {
      if (row.uid >= 0 && row.uid < buffer.length) {
        buffer[row.uid] = row.status;
      }
    }
    return buffer.join('');
  }

  private parseStatusString(body: string) {
    try {
      const parsed = JSON.parse(body) as unknown;
      if (typeof parsed === 'string') {
        this.assertValidStatusString(parsed);
        return parsed;
      }
    } catch {
      // Some proxies may strip JSON string quoting; fall through to raw-text parsing.
    }

    const normalized = body.replace(/\r/g, '').replace(/\n/g, '');
    this.assertValidStatusString(normalized);
    return normalized;
  }

  private assertValidStatusString(value: string) {
    for (const symbol of value) {
      if (!VALID_STATUSES.has(symbol as AlertStatus)) {
        throw new Error(`Unexpected status symbol received from alerts.in.ua: ${JSON.stringify(symbol)}`);
      }
    }
  }

  private statusAtUid(statusString: string, uid: number): AlertStatus {
    const symbol = statusString[uid] ?? ' ';
    return this.normalizeStatus(symbol);
  }

  private normalizeStatus(value: string | undefined): AlertStatus {
    if (!value) {
      return ' ';
    }

    const symbol = value[0] as AlertStatus;
    if (VALID_STATUSES.has(symbol)) {
      return symbol;
    }

    return ' ';
  }

  private resolveActiveFrom(
    previousActiveFrom: string | null,
    previousStatus: AlertStatus,
    newStatus: AlertStatus,
    occurredAt: Date,
  ) {
    const wasActive = ACTIVE_STATUSES.has(previousStatus);
    const isActive = ACTIVE_STATUSES.has(newStatus);

    if (!wasActive && isActive) {
      return occurredAt.toISOString();
    }

    if (wasActive && isActive) {
      return previousActiveFrom;
    }

    return null;
  }

  private resolveEventKind(previousStatus: AlertStatus, newStatus: AlertStatus) {
    const wasActive = ACTIVE_STATUSES.has(previousStatus);
    const isActive = ACTIVE_STATUSES.has(newStatus);

    if (!wasActive && isActive) {
      return 'started';
    }

    if (wasActive && !isActive) {
      return 'ended';
    }

    return 'state_changed';
  }

  private mapHttpStatusToErrorCode(httpStatus: number) {
    switch (httpStatus) {
      case 401:
        return 'UNAUTHORIZED';
      case 403:
        return 'FORBIDDEN';
      case 429:
        return 'RATE_LIMITED';
      default:
        return 'UPSTREAM_HTTP_ERROR';
    }
  }

  private extractErrorMessage(body: string) {
    try {
      const parsed = JSON.parse(body) as { message?: unknown };
      if (typeof parsed.message === 'string') {
        return parsed.message;
      }
    } catch {
      // Keep raw body below.
    }

    return body.trim().slice(0, 500) || 'Upstream request failed without a response body.';
  }

  private stringifyError(error: unknown) {
    if (error instanceof Error) {
      return `${error.name}: ${error.message}`.slice(0, 500);
    }

    return String(error).slice(0, 500);
  }
}
