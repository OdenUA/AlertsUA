import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../common/database/database.service';
import { TimeUtil } from '../../common/utils/time.util';

type OutboxEntityType =
  | 'regions_ref'
  | 'devices'
  | 'device_push_tokens'
  | 'subscriptions'
  | 'alert_event_log'
  | 'notification_log';

type OutboxOperation = 'insert' | 'update' | 'delete';

type OutboxRow = {
  outbox_id: number;
  entity_type: OutboxEntityType;
  entity_id: string;
  operation: OutboxOperation;
  payload: Record<string, unknown> | string | null;
  attempts: number;
};

type EntityCountMap = Record<OutboxEntityType, number>;

type RegionRefRow = {
  uid: number;
  region_type: string;
  title_uk: string;
  parent_uid: number | null;
  oblast_uid: number | null;
  raion_uid: number | null;
  source_version: string;
  updated_at: string;
};

type DeviceRow = {
  installation_id: string;
  platform: string;
  locale: string;
  app_version: string;
  status: string;
  created_at: string;
  last_seen_at: string;
};

type DevicePushTokenRow = {
  token_id: string;
  installation_id: string;
  fcm_token: string;
  is_active: boolean;
  last_seen_at: string;
  last_success_at: string | null;
  last_error_code: string | null;
};

type SubscriptionRow = {
  subscription_id: string;
  installation_id: string;
  label_user: string | null;
  address_uk: string;
  latitude: number;
  longitude: number;
  leaf_uid: number | null;
  raion_uid: number | null;
  oblast_uid: number | null;
  notify_on_start: boolean;
  notify_on_end: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

type AlertEventRow = {
  event_id: string;
  uid: number;
  event_kind: string;
  previous_status: string;
  new_status: string;
  state_version: number;
  occurred_at: string;
  created_at: string;
};

type NotificationLogRow = {
  dispatch_id: string;
  subscription_id: string;
  installation_id: string;
  event_id: string;
  dispatch_kind: string;
  status: string;
  provider_message_id: string | null;
  provider_error_code: string | null;
  queued_at: string;
  sent_at: string | null;
};

type RemoteSchemaProbe = {
  table: string;
  primaryKey: string;
};

const ENTITY_CONFIG: Record<
  OutboxEntityType,
  {
    table: string;
    primaryKey: string;
    onConflict: string;
  }
> = {
  regions_ref: {
    table: 'regions_ref',
    primaryKey: 'uid',
    onConflict: 'uid',
  },
  devices: {
    table: 'devices',
    primaryKey: 'installation_id',
    onConflict: 'installation_id',
  },
  device_push_tokens: {
    table: 'device_push_tokens',
    primaryKey: 'token_id',
    onConflict: 'token_id',
  },
  subscriptions: {
    table: 'subscriptions',
    primaryKey: 'subscription_id',
    onConflict: 'subscription_id',
  },
  alert_event_log: {
    table: 'alert_event_log',
    primaryKey: 'event_id',
    onConflict: 'event_id',
  },
  notification_log: {
    table: 'notification_log',
    primaryKey: 'dispatch_id',
    onConflict: 'dispatch_id',
  },
};

@Injectable()
export class SupabaseSyncService {
  private readonly supabaseClient: SupabaseClient | null;

  constructor(
    private readonly configService: ConfigService,
    private readonly databaseService: DatabaseService,
  ) {
    const supabaseUrl = this.configService.get<string>('SUPABASE_URL');
    const supabaseSecret =
      this.configService.get<string>('SUPABASE_SECRET_KEY') ??
      this.configService.get<string>('SUPABASE_SERVICE_KEY');

    this.supabaseClient =
      supabaseUrl && supabaseSecret
        ? createClient(supabaseUrl, supabaseSecret, {
            auth: {
              autoRefreshToken: false,
              persistSession: false,
            },
          })
        : null;
  }

  isConfigured() {
    return this.supabaseClient !== null;
  }

  hashPushToken(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  async enqueueEntity(
    client: PoolClient,
    input: {
      entity_type: OutboxEntityType;
      entity_id: string | number;
      operation: OutboxOperation;
      payload: Record<string, unknown>;
      available_at?: string;
    },
  ) {
    await client.query(
      `
        INSERT INTO supabase_outbox (
          entity_type,
          entity_id,
          operation,
          payload,
          available_at,
          attempts,
          last_error,
          processed_at
        ) VALUES ($1, $2, $3, $4::jsonb, $5, 0, NULL, NULL)
      `,
      [
        input.entity_type,
        String(input.entity_id),
        input.operation,
        JSON.stringify(input.payload),
        input.available_at ?? TimeUtil.getNowInKyiv(),
      ],
    );
  }

  async processOutbox(options?: {
    bootstrap?: boolean;
    batchLimit?: number;
    maxBatches?: number;
  }) {
    if (!this.isConfigured()) {
      return {
        worker: 'sync',
        status: 'disabled',
        reason: 'supabase_credentials_missing',
      };
    }

    const batchLimit = options?.batchLimit ?? 250;
    const maxBatches = options?.maxBatches ?? 20;
    const bootstrappedByEntity = this.createEmptyEntityCounts();
    const processedByEntity = this.createEmptyEntityCounts();
    let bootstrapped = 0;
    let processed = 0;
    let failed = 0;
    let upserted = 0;
    let deleted = 0;

    const missingTables = await this.getMissingRemoteTables();
    if (missingTables.length > 0) {
      return {
        worker: 'sync',
        status: 'blocked',
        reason: 'supabase_remote_schema_missing',
        missing_tables: missingTables,
      };
    }

    if (options?.bootstrap) {
      const bootstrapResult = await this.bootstrapFullSnapshot();
      bootstrapped = bootstrapResult.enqueued;
      for (const entityType of Object.keys(bootstrappedByEntity) as OutboxEntityType[]) {
        bootstrappedByEntity[entityType] = bootstrapResult.enqueued_by_entity[entityType];
      }
    }

    for (let batchIndex = 0; batchIndex < maxBatches; batchIndex += 1) {
      const batch = await this.claimPendingBatch(batchLimit);
      if (batch.length === 0) {
        break;
      }

      for (const entry of batch) {
        try {
          await this.processEntry(entry);
          await this.databaseService.query(
            `
              UPDATE supabase_outbox
              SET processed_at = NOW(),
                  last_error = NULL
              WHERE outbox_id = $1
            `,
            [entry.outbox_id],
          );

          processed += 1;
          processedByEntity[entry.entity_type] += 1;
          if (entry.operation === 'delete') {
            deleted += 1;
          } else {
            upserted += 1;
          }
        } catch (error) {
          failed += 1;
          const attemptNo = entry.attempts + 1;
          await this.databaseService.query(
            `
              UPDATE supabase_outbox
              SET last_error = $2,
                  available_at = NOW() + ($3::int * INTERVAL '30 seconds')
              WHERE outbox_id = $1
            `,
            [entry.outbox_id, this.stringifyError(error), attemptNo],
          );
        }
      }
    }

    const pendingResult = await this.databaseService.query<{ count: string }>(
      `
        SELECT COUNT(*) AS count
        FROM supabase_outbox
        WHERE processed_at IS NULL
      `,
    );

    return {
      worker: 'sync',
      status:
        bootstrapped === 0 && processed === 0 && failed === 0 ? 'idle' : 'processed',
      bootstrapped,
      bootstrapped_by_entity: bootstrappedByEntity,
      processed,
      processed_by_entity: processedByEntity,
      upserted,
      deleted,
      failed,
      pending: Number(pendingResult.rows[0]?.count ?? 0),
    };
  }

  private async bootstrapFullSnapshot() {
    const enqueuedByEntity = this.createEmptyEntityCounts();

    const enqueued = await this.databaseService.withTransaction(async (client) => {
      let total = 0;

      const regionsResult = await client.query<RegionRefRow>(
        `
          SELECT uid,
                 region_type,
                 title_uk,
                 parent_uid,
                 oblast_uid,
                 raion_uid,
                 source_version,
                 updated_at::text
          FROM region_catalog
          WHERE is_active = TRUE
          ORDER BY uid ASC
        `,
      );

      for (const row of regionsResult.rows) {
        await this.enqueueEntity(client, {
          entity_type: 'regions_ref',
          entity_id: row.uid,
          operation: 'update',
          payload: row,
        });
        enqueuedByEntity.regions_ref += 1;
        total += 1;
      }

      const devicesResult = await client.query<DeviceRow>(
        `
          SELECT installation_id,
                 platform,
                 locale,
                 app_version,
                 status,
                 created_at::text,
                 last_seen_at::text
          FROM device_installations
          ORDER BY created_at ASC
        `,
      );

      for (const row of devicesResult.rows) {
        await this.enqueueEntity(client, {
          entity_type: 'devices',
          entity_id: row.installation_id,
          operation: 'update',
          payload: row,
        });
        enqueuedByEntity.devices += 1;
        total += 1;
      }

      const pushTokensResult = await client.query<DevicePushTokenRow>(
        `
          SELECT token_id,
                 installation_id,
                 fcm_token,
                 is_active,
                 last_seen_at::text,
                 last_success_at::text,
                 last_error_code
          FROM device_push_tokens
          ORDER BY last_seen_at ASC
        `,
      );

      for (const row of pushTokensResult.rows) {
        await this.enqueueEntity(client, {
          entity_type: 'device_push_tokens',
          entity_id: row.token_id,
          operation: 'update',
          payload: {
            token_id: row.token_id,
            installation_id: row.installation_id,
            token_hash: this.hashPushToken(row.fcm_token),
            is_active: row.is_active,
            last_seen_at: row.last_seen_at,
            last_success_at: row.last_success_at,
            last_error_code: row.last_error_code,
          },
        });
        enqueuedByEntity.device_push_tokens += 1;
        total += 1;
      }

      const subscriptionsResult = await client.query<SubscriptionRow>(
        `
          SELECT subscription_id,
                 installation_id,
                 label_user,
                 address_uk,
                 latitude,
                 longitude,
                 leaf_uid,
                 raion_uid,
                 oblast_uid,
                 notify_on_start,
                 notify_on_end,
                 is_active,
                 created_at::text,
                 updated_at::text
          FROM subscriptions
          ORDER BY created_at ASC
        `,
      );

      for (const row of subscriptionsResult.rows) {
        await this.enqueueEntity(client, {
          entity_type: 'subscriptions',
          entity_id: row.subscription_id,
          operation: 'update',
          payload: row,
        });
        enqueuedByEntity.subscriptions += 1;
        total += 1;
      }

      const eventsResult = await client.query<AlertEventRow>(
        `
          SELECT event_id,
                 uid,
                 event_kind,
                 previous_status,
                 new_status,
                 state_version,
                 occurred_at::text,
                 created_at::text
          FROM air_raid_events
          ORDER BY occurred_at ASC, event_id ASC
        `,
      );

      for (const row of eventsResult.rows) {
        await this.enqueueEntity(client, {
          entity_type: 'alert_event_log',
          entity_id: row.event_id,
          operation: 'insert',
          payload: row,
        });
        enqueuedByEntity.alert_event_log += 1;
        total += 1;
      }

      const notificationLogResult = await client.query<NotificationLogRow>(
        `
          SELECT dispatch_id,
                 subscription_id,
                 installation_id,
                 event_id,
                 dispatch_kind,
                 status,
                 provider_message_id,
                 provider_error_code,
                 queued_at::text,
                 sent_at::text
          FROM notification_dispatches
          ORDER BY queued_at ASC, dispatch_id ASC
        `,
      );

      for (const row of notificationLogResult.rows) {
        await this.enqueueEntity(client, {
          entity_type: 'notification_log',
          entity_id: row.dispatch_id,
          operation: 'update',
          payload: row,
        });
        enqueuedByEntity.notification_log += 1;
        total += 1;
      }

      return total;
    });

    return {
      enqueued,
      enqueued_by_entity: enqueuedByEntity,
    };
  }

  private async claimPendingBatch(limit: number) {
    return this.databaseService.withTransaction(async (client) => {
      const result = await client.query<OutboxRow>(
        `
          SELECT outbox_id,
                 entity_type,
                 entity_id,
                 operation,
                 payload,
                 attempts
          FROM supabase_outbox
          WHERE processed_at IS NULL
            AND available_at <= NOW()
          ORDER BY outbox_id ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
        `,
        [limit],
      );

      if (result.rowCount === 0) {
        return [];
      }

      await client.query(
        'UPDATE supabase_outbox SET attempts = attempts + 1 WHERE outbox_id = ANY($1::bigint[])',
        [result.rows.map((row) => row.outbox_id)],
      );

      return result.rows;
    });
  }

  private async getMissingRemoteTables() {
    if (!this.supabaseClient) {
      return [];
    }

    const supabaseClient = this.supabaseClient;
    const probes = this.getRemoteSchemaProbes();
    const results = await Promise.all(
      probes.map(async ({ table, primaryKey }) => {
        const { error } = await supabaseClient
          .from(table)
          .select(primaryKey)
          .limit(1);

        if (!error) {
          return null;
        }

        if (
          error.code === 'PGRST205' ||
          /could not find the table/i.test(error.message)
        ) {
          return table;
        }

        throw new Error(`supabase_schema_check:${table}: ${error.message}`);
      }),
    );

    return results.filter((table): table is string => table !== null);
  }

  private async processEntry(entry: OutboxRow) {
    const entityConfig = ENTITY_CONFIG[entry.entity_type];
    if (!entityConfig) {
      throw new Error(`Unknown supabase entity type: ${entry.entity_type}`);
    }

    if (!this.supabaseClient) {
      throw new Error('Supabase client is not configured.');
    }

    if (entry.operation === 'delete') {
      const identifier = this.resolvePrimaryKeyValue(entry, entityConfig.primaryKey);
      const { error } = await this.supabaseClient
        .from(entityConfig.table)
        .delete()
        .eq(entityConfig.primaryKey, identifier);

      if (error) {
        throw new Error(`${entry.entity_type}:${entry.entity_id}: ${error.message}`);
      }

      return;
    }

    const payload = this.normalizePayload(entry.payload) as Record<string, unknown>;
    const { error } = await this.supabaseClient
      .from(entityConfig.table)
      .upsert(payload, {
        onConflict: entityConfig.onConflict,
      });

    if (error) {
      throw new Error(`${entry.entity_type}:${entry.entity_id}: ${error.message}`);
    }
  }

  private resolvePrimaryKeyValue(
    entry: OutboxRow,
    primaryKey: string,
  ): string | number {
    const payload = this.normalizePayload(entry.payload, false);
    const candidate = payload?.[primaryKey] ?? entry.entity_id;

    if (primaryKey === 'uid') {
      return Number(candidate);
    }

    return String(candidate);
  }

  private normalizePayload(payload: OutboxRow['payload'], requireObject = true) {
    if (payload === null) {
      if (requireObject) {
        throw new Error('Supabase outbox payload is empty.');
      }

      return null;
    }

    if (typeof payload === 'string') {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      if (requireObject && Array.isArray(parsed)) {
        throw new Error('Supabase outbox payload must be a JSON object.');
      }
      return parsed;
    }

    if (requireObject && Array.isArray(payload)) {
      throw new Error('Supabase outbox payload must be a JSON object.');
    }

    return payload;
  }

  private createEmptyEntityCounts(): EntityCountMap {
    return {
      regions_ref: 0,
      devices: 0,
      device_push_tokens: 0,
      subscriptions: 0,
      alert_event_log: 0,
      notification_log: 0,
    };
  }

  private getRemoteSchemaProbes(): RemoteSchemaProbe[] {
    const uniqueProbes = new Map<string, RemoteSchemaProbe>();

    for (const config of Object.values(ENTITY_CONFIG)) {
      if (!uniqueProbes.has(config.table)) {
        uniqueProbes.set(config.table, {
          table: config.table,
          primaryKey: config.primaryKey,
        });
      }
    }

    return [...uniqueProbes.values()];
  }

  private stringifyError(error: unknown) {
    if (error instanceof Error) {
      return `${error.name}: ${error.message}`.slice(0, 500);
    }

    return String(error).slice(0, 500);
  }
}