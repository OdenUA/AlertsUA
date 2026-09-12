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
type AlertLevel = 'red' | 'yellow';

type AlertAttributes = {
  alert_type: AlertType;
  alert_level: AlertLevel;
};

type PollMetadata = {
  last_modified: string | null;
  status_string_hash: string | null;
  status_string: string | null;
  state_version: number;
};

type CurrentStateRow = {
  uid: number;
  status: AlertStatus;
  state_version: number;
  active_from: string | null;
  alert_type: AlertType;
  alert_level: AlertLevel;
  updated_at: string;
};

type AppliedSnapshot = {
  state_version: number;
  bootstrap_mode: boolean;
  changed_uids: number[];
  level_changed_uids: number[];
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

const VALID_ALERT_LEVELS = new Set<AlertLevel>(['red', 'yellow']);
const DEFAULT_ALERT_LEVEL: AlertLevel = 'red';

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
        status_string: null,
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
      // The IoT status string did not change, but alert attributes
      // (alert_type / alert_level) exist only in active.json — check them too.
      const alertAttributes = await this.fetchActiveAlertAttributes();
      const attributesHash = this.hashAlertAttributes(alertAttributes);
      const combinedHash = this.hashStatusWithAttributes(previousMetadata.status_string, attributesHash);
      const attributesChanged =
        previousMetadata.status_string !== null &&
        combinedHash !== null &&
        previousMetadata.status_string_hash !== combinedHash;

      if (attributesChanged) {
        const changedCycleId = await this.insertPollCycle({
          requested_at: requestedAt,
          finished_at: finishedAt,
          http_status: httpStatus,
          if_modified_since_sent: previousMetadata.last_modified,
          last_modified_received: lastModifiedReceived ?? previousMetadata.last_modified,
          status_string_hash: combinedHash,
          status_string: previousMetadata.status_string,
          changed: true,
          error_code: null,
          error_message: null,
        });

        try {
          const appliedSnapshot = await this.databaseService.withTransaction((client) =>
            this.applyStatusSnapshot(client, {
              cycle_id: changedCycleId,
              occurred_at: finishedAt,
              status_string: previousMetadata.status_string as string,
              alert_attributes: alertAttributes,
            }),
          );

          return {
            cycle_id: changedCycleId,
            http_status: httpStatus,
            changed: true,
            state_version: appliedSnapshot.state_version,
            bootstrap_mode: appliedSnapshot.bootstrap_mode,
            changed_uids: appliedSnapshot.changed_uids.length,
            level_changed_uids: appliedSnapshot.level_changed_uids.length,
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
            [changedCycleId, 'PROCESSING_FAILED', this.stringifyError(error)],
          );
          throw error;
        }
      }

      // Refresh cache even when API returns 304 to prevent expiration
      try {
        await this.databaseService.withTransaction(async (client) => {
          const bundle = await this.buildAlertsBundle(client, previousMetadata.state_version);
          await this.cacheService.set(CACHE_KEYS.ALERTS_CURRENT, bundle, CACHE_TTL.ALERTS);
          this.logger.log(`Alerts cache refreshed (304 response): state_version=${previousMetadata.state_version}`);
          await this.refreshAlertLayerCaches(client, '304 response');
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
        status_string_hash: combinedHash ?? previousMetadata.status_string_hash,
        status_string: previousMetadata.status_string,
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
        status_string: null,
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
    // Alert attributes (alert_type / alert_level) are not part of the IoT
    // status string — fetch them from active.json on every 200 response so
    // level-only changes (e.g. yellow -> red) are detected as well.
    const alertAttributes = await this.fetchActiveAlertAttributes();
    const attributesHash = this.hashAlertAttributes(alertAttributes);
    const combinedHash = this.hashStatusWithAttributes(statusString, attributesHash) as string;
    const sourceChanged = previousMetadata.status_string_hash !== combinedHash;
    const cycleId = await this.insertPollCycle({
      requested_at: requestedAt,
      finished_at: finishedAt,
      http_status: httpStatus,
      if_modified_since_sent: previousMetadata.last_modified,
      last_modified_received: lastModifiedReceived ?? previousMetadata.last_modified,
      status_string_hash: combinedHash,
      status_string: statusString,
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
          await this.refreshAlertLayerCaches(client, 'no changes');
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
      const appliedSnapshot = await this.databaseService.withTransaction((client) =>
        this.applyStatusSnapshot(client, {
          cycle_id: cycleId,
          occurred_at: finishedAt,
          status_string: statusString,
          alert_attributes: alertAttributes,
        }),
      );

      return {
        cycle_id: cycleId,
        http_status: httpStatus,
        changed: true,
        state_version: appliedSnapshot.state_version,
        bootstrap_mode: appliedSnapshot.bootstrap_mode,
        changed_uids: appliedSnapshot.changed_uids.length,
        level_changed_uids: appliedSnapshot.level_changed_uids.length,
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
    const [lastCycleResult, lastStatusStringResult, stateVersionResult] = await Promise.all([
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
      // Latest known raw IoT status string — needed to apply attribute-only
      // changes (alert_type / alert_level) when the IoT endpoint returns 304.
      this.databaseService.query<{ status_string: string | null }>(
        `
          SELECT status_string
          FROM alert_poll_cycles
          WHERE status_string IS NOT NULL
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
      status_string: lastStatusStringResult.rows[0]?.status_string ?? null,
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
    status_string: string | null;
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
          status_string,
          changed,
          error_code,
          error_message
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING cycle_id
      `,
      [
        input.requested_at.toISOString(),
        input.finished_at.toISOString(),
        input.http_status,
        input.if_modified_since_sent,
        input.last_modified_received,
        input.status_string_hash,
        input.status_string,
        input.changed,
        input.error_code,
        input.error_message,
      ],
    );

    return Number(result.rows[0].cycle_id);
  }

  private async fetchActiveAlertAttributes(): Promise<Map<number, AlertAttributes>> {
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
        alerts?: Array<{ location_uid?: string; alert_type?: string; alert_level?: string }>;
      };
      const map = new Map<number, AlertAttributes>();

      for (const alert of body.alerts ?? []) {
        const uid = Number(alert.location_uid);
        const alertType = alert.alert_type;
        if (!Number.isFinite(uid) || uid <= 0 || !alertType || !VALID_ALERT_TYPES.has(alertType as AlertType)) {
          continue;
        }

        const alertLevel = VALID_ALERT_LEVELS.has(alert.alert_level as AlertLevel)
          ? alert.alert_level as AlertLevel
          : DEFAULT_ALERT_LEVEL;

        const existing = map.get(uid);
        if (!existing) {
          map.set(uid, { alert_type: alertType as AlertType, alert_level: alertLevel });
          continue;
        }

        // A region can have several concurrent alerts: air_raid takes priority
        // over other types, red takes priority over yellow.
        map.set(uid, {
          alert_type: existing.alert_type === 'air_raid' || alertType !== 'air_raid'
            ? existing.alert_type
            : alertType as AlertType,
          alert_level: existing.alert_level === 'red' || alertLevel === 'red' ? 'red' : 'yellow',
        });
      }

      return map;
    } catch {
      return new Map();
    }
  }

  private hashAlertAttributes(attributes: Map<number, AlertAttributes>): string {
    const serialized = [...attributes.entries()]
      .sort(([a], [b]) => a - b)
      .map(([uid, attr]) => `${uid}:${attr.alert_type}:${attr.alert_level}`)
      .join(',');
    return createHash('sha256').update(serialized).digest('hex');
  }

  private hashStatusWithAttributes(statusString: string | null, attributesHash: string): string | null {
    if (statusString === null) {
      return null;
    }

    const statusHash = createHash('sha256').update(statusString).digest('hex');
    return createHash('sha256').update(`${statusHash}|${attributesHash}`).digest('hex');
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
        alert_level: string;
        geometry_json: string;
      }>(
        `
          -- Get subscription_leaf regions with alerts (hromadas, cities)
          SELECT rc.uid, rc.title_uk, rc.region_type, arc.alert_type, arc.alert_level,
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
                 COALESCE(par.alert_level, 'red') AS alert_level,
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

    this.logger.log(`buildAlertsBundle: Query returned ${activeAlertsResult.rows.length} rows`);
    const activeAlerts = activeAlertsResult.rows.map((row) => ({
      uid: row.uid,
      title_uk: row.title_uk,
      region_type: row.region_type,
      alert_type: row.alert_type,
      alert_level: row.alert_level,
      geometry: JSON.parse(row.geometry_json),
    }));
    this.logger.log(`buildAlertsBundle: activeAlerts contains ${activeAlerts.length} features (raions: ${activeAlerts.filter(a => a.region_type === 'raion').length}, hromadas: ${activeAlerts.filter(a => a.region_type === 'hromada').length})`);

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
      alert_attributes: Map<number, AlertAttributes>;
    },
  ): Promise<AppliedSnapshot> {
    const [regionRowsResult, currentRowsResult, stateVersionResult] = await Promise.all([
      client.query<{ uid: number }>(
        'SELECT uid, oblast_uid, parent_uid, region_type FROM region_catalog WHERE is_active = TRUE ORDER BY uid ASC',
      ),
      client.query<{
        uid: number;
        status: AlertStatus;
        state_version: number;
        active_from: string | null;
        alert_type: AlertType;
        alert_level: AlertLevel;
      }>(
        `
          SELECT uid, status, state_version, active_from::text, alert_type, alert_level
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

    const alertAttributes = input.alert_attributes;

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
    // Regions whose alert level (red/yellow) changed while the status stayed
    // the same — they do not produce events/pushes, but must bump state_version
    // so map clients re-render the fill color.
    const levelChangedUids: number[] = [];

    const nextRows = (regionRowsResult.rows as Array<{
      uid: number;
      oblast_uid: number | null;
      parent_uid: number | null;
      region_type: string;
    }>).map(({ uid, oblast_uid, parent_uid, region_type }) => {
      const previousState = previousStates.get(uid);
      const previousStatus = previousState?.status ?? ' ';
      let newStatus = this.statusAtUid(input.status_string, uid);

      // The IoT string only tracks air_raid status. For other alert types
      // we trust the active alerts endpoint only for the same uid.
      if (newStatus !== 'A' && alertAttributes.has(uid)) {
        newStatus = 'A';
      }

      const activeFrom = this.resolveActiveFrom(
        previousState?.active_from ?? null,
        previousStatus,
        newStatus,
        input.occurred_at,
      );

      if (previousStatus !== newStatus) {
        const changedAlertType = alertAttributes.get(uid)?.alert_type
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

      const alertType = alertAttributes.get(uid)?.alert_type
        ?? previousState?.alert_type
        ?? 'air_raid';
      const hasOwnAttributes = alertAttributes.has(uid);
      const alertLevel = ACTIVE_STATUSES.has(newStatus)
        ? alertAttributes.get(uid)?.alert_level
          ?? previousState?.alert_level
          ?? DEFAULT_ALERT_LEVEL
        : previousState?.alert_level ?? DEFAULT_ALERT_LEVEL;

      return {
        uid,
        oblast_uid,
        parent_uid,
        region_type,
        status: newStatus,
        active_from: activeFrom,
        alert_type: alertType,
        alert_level: alertLevel,
        hasOwnAttributes,
        levelInherited: false,
      };
    });

    // Resolve alert level for regions without their own entry in active.json.
    // alerts.in.ua reports yellow-level threats mostly at raion/city level while
    // the IoT string marks every hromada in them as active ('A'), so levels are
    // resolved hierarchically:
    // 1) inherit from the nearest ancestor that has an own entry (raion entry
    //    covers its hromadas, oblast entry covers its raions/hromadas);
    // 2) parents (oblast/raion) still without an entry derive from active
    //    descendants — red wins, yellow only when ALL descendants are yellow.
    const rowsByUid = new Map(nextRows.map((row) => [row.uid, row]));

    for (const row of nextRows) {
      if (row.hasOwnAttributes || !ACTIVE_STATUSES.has(row.status)) {
        continue;
      }

      let ancestor = row.parent_uid !== null ? rowsByUid.get(row.parent_uid) : undefined;
      while (ancestor) {
        if (ancestor.hasOwnAttributes) {
          row.alert_level = ancestor.alert_level;
          row.levelInherited = true;
          break;
        }
        ancestor = ancestor.parent_uid !== null ? rowsByUid.get(ancestor.parent_uid) : undefined;
      }
    }

    for (const row of nextRows) {
      if (row.hasOwnAttributes || row.levelInherited || !ACTIVE_STATUSES.has(row.status)) {
        continue;
      }
      if (row.region_type !== 'oblast' && row.region_type !== 'raion') {
        continue;
      }

      const activeDescendants = nextRows.filter((candidate) =>
        candidate.uid !== row.uid &&
        ACTIVE_STATUSES.has(candidate.status) &&
        (row.region_type === 'oblast'
          ? candidate.oblast_uid === row.uid
          : candidate.parent_uid === row.uid),
      );
      if (activeDescendants.length === 0) {
        continue;
      }

      row.alert_level = activeDescendants.some((candidate) => candidate.alert_level === 'red')
        ? 'red'
        : 'yellow';
    }

    // Inherit status from parent oblast: if the oblast is active ('A'), upgrade
    // all child cities/hromadas to 'A' as well.  Without this, cities like
    // м. Київ whose UID is absent from the IoT status string (or marked 'P')
    // stay inactive even when the surrounding oblast is fully active — breaking
    // both the map overlay and the bottom-sheet status display.
    for (const row of nextRows) {
      if (ACTIVE_STATUSES.has(row.status) || !row.oblast_uid) continue;
      const oblast = rowsByUid.get(row.oblast_uid);
      if (oblast && oblast.status === 'A') {
        row.status = 'A';
        if (!row.alert_type || row.alert_type === 'air_raid') {
          row.alert_type = oblast.alert_type;
        }
        if (!row.hasOwnAttributes) {
          row.alert_level = oblast.alert_level;
          row.levelInherited = true;
        }
      }
    }

    for (const row of nextRows) {
      const previousState = previousStates.get(row.uid);
      if (
        previousState &&
        previousState.status === row.status &&
        ACTIVE_STATUSES.has(row.status) &&
        previousState.alert_level !== row.alert_level
      ) {
        levelChangedUids.push(row.uid);
      }
    }

    if (!bootstrapMode && changedRows.length === 0 && levelChangedUids.length === 0) {
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
        level_changed_uids: [],
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
            alert_type,
            alert_level
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (uid) DO UPDATE SET
            status = EXCLUDED.status,
            state_version = EXCLUDED.state_version,
            active_from = EXCLUDED.active_from,
            updated_at = EXCLUDED.updated_at,
            source_cycle_id = EXCLUDED.source_cycle_id,
            alert_type = EXCLUDED.alert_type,
            alert_level = EXCLUDED.alert_level
        `,
        [
          row.uid,
          row.status,
          nextStateVersion,
          row.active_from,
          input.occurred_at.toISOString(),
          input.cycle_id,
          row.alert_type,
          row.alert_level,
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

    // Rebuild precomputed alert layer for fast map rendering
    try {
      await this.refreshAlertLayerCaches(client, `state_version=${nextStateVersion}`);
    } catch (error) {
      this.logger.error(`Failed to rebuild alert layer: ${error}`);
    }

    return {
      state_version: nextStateVersion,
      bootstrap_mode: bootstrapMode,
      changed_uids: changedRows.map((row) => row.uid),
      level_changed_uids: levelChangedUids,
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

  private async rebuildAlertLayer(client: PoolClient): Promise<void> {
    // Clear existing alert layer
    await client.query('DELETE FROM alert_layer_features');

    // Insert all regions with active alerts (raions and hromadas that are subscription_leaf)
    // Also include cities (like Kyiv city) but NOT oblasts - their children are included instead
    const result = await client.query<{
      uid: number;
      region_type: string;
      alert_type: string;
      alert_level: string;
      geometry_json: string;
    }>(
      `
        INSERT INTO alert_layer_features (uid, region_type, alert_type, alert_level, geometry_json)
        SELECT rc.uid,
               rc.region_type,
               COALESCE(arc.alert_type, arc_parent.alert_type, 'air_raid') AS alert_type,
               COALESCE(arc.alert_level, arc_parent.alert_level, 'red') AS alert_level,
               ST_AsGeoJSON(
                 COALESCE(rgl.geom, ST_Simplify(rg.geom, 0.01))
               ) AS geometry_json
        FROM region_catalog rc
        JOIN region_geometry rg ON rg.uid = rc.uid
        LEFT JOIN region_geometry_lod rgl ON rgl.uid = rc.uid AND rgl.lod = 'low'
        LEFT JOIN air_raid_state_current arc ON arc.uid = rc.uid
        LEFT JOIN air_raid_state_current arc_parent
          ON arc_parent.uid = rc.oblast_uid AND arc_parent.status = 'A'
        WHERE (
            arc.status = 'A'
            OR (rc.region_type = 'city' AND arc_parent.uid IS NOT NULL)
          )
          AND (
            -- Include cities with direct or inherited alerts (but not oblasts)
            rc.region_type = 'city'
            OR
            -- Include subscription_leaf regions (hromadas, some raions)
            rc.is_subscription_leaf = TRUE
          )
        ON CONFLICT (feature_id) DO UPDATE SET
          uid = EXCLUDED.uid,
          region_type = EXCLUDED.region_type,
          alert_type = EXCLUDED.alert_type,
          alert_level = EXCLUDED.alert_level,
          geometry_json = EXCLUDED.geometry_json,
          updated_at = NOW();
      `,
    );

    this.logger.debug(`Rebuilt alert layer: ${result.rowCount} features`);
  }

  /**
   * Rebuilds the precomputed alert layer and refreshes the lightweight
   * active-UIDs cache (with per-region alert_type / alert_level details),
   * then invalidates all alert/feature caches so clients pick up fresh data.
   */
  private async refreshAlertLayerCaches(client: PoolClient, logContext: string): Promise<void> {
    await this.rebuildAlertLayer(client);

    // Cache active UIDs for subscription_leaf regions only (hromadas + cities).
    // DO NOT include raions/oblasts — they are parent regions filled by their active children.
    // Cities inherit active status from their parent oblast (e.g. м. Київ from Київська область).
    const activeUidsResult = await client.query<{ uid: number; alert_type: string; alert_level: string }>(
      `SELECT rc.uid,
              COALESCE(arc.alert_type, arc_parent.alert_type, 'air_raid') AS alert_type,
              COALESCE(arc.alert_level, arc_parent.alert_level, 'red') AS alert_level
       FROM region_catalog rc
       LEFT JOIN air_raid_state_current arc ON arc.uid = rc.uid
       LEFT JOIN air_raid_state_current arc_parent
         ON arc_parent.uid = rc.oblast_uid AND arc_parent.status = 'A'
       WHERE rc.is_active = TRUE
         AND (rc.is_subscription_leaf = TRUE OR rc.region_type = 'city')
         AND (arc.status IN ('A', 'P') OR (rc.region_type = 'city' AND arc_parent.uid IS NOT NULL))`,
    );
    const activeUids = activeUidsResult.rows.map((r) => r.uid);
    const details: Record<number, { alert_type: string; alert_level: string }> = {};
    for (const row of activeUidsResult.rows) {
      details[row.uid] = { alert_type: row.alert_type, alert_level: row.alert_level };
    }
    await this.cacheService.set(CACHE_KEYS.ALERTS_ACTIVE_UIDS, { uids: activeUids, details }, CACHE_TTL.ALERTS);

    // Immediately invalidate full alert caches so next request gets fresh data
    await this.cacheService.delete([CACHE_KEYS.ALERTS_LAYER, CACHE_KEYS.ALERTS_CURRENT]);
    // Invalidate all feature caches (geometry bundles with stale status)
    await this.cacheService.delete([
      CACHE_KEYS.FEATURES('oblast', 'low'),
      CACHE_KEYS.FEATURES('oblast', 'medium'),
      CACHE_KEYS.FEATURES('raion', 'medium'),
      CACHE_KEYS.FEATURES('raion', 'high'),
      CACHE_KEYS.FEATURES('hromada', 'medium'),
      CACHE_KEYS.FEATURES('hromada', 'high'),
    ]);

    this.logger.log(`Precomputed alert layer rebuilt, ${activeUids.length} active UIDs cached and caches invalidated (${logContext})`);
  }
}
