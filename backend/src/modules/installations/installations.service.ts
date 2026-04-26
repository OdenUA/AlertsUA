import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../common/database/database.service';
import { SupabaseSyncService } from '../supabase/supabase-sync.service';
import { TimeUtil } from '../../common/utils/time.util';
import { RegisterInstallationDto } from './dto/register-installation.dto';
import { UpdateInstallationDto } from './dto/update-installation.dto';

type InstallationIdentity = {
  installation_id: string;
  platform: string;
  locale: string;
  app_version: string;
  app_build: string | null;
  device_model: string | null;
  notifications_enabled: boolean;
  status: string;
  last_seen_at: string;
};

type DeviceSyncRow = {
  installation_id: string;
  platform: string;
  locale: string;
  app_version: string;
  status: string;
  created_at: string;
  last_seen_at: string;
};

type PushTokenSyncRow = {
  token_id: string;
  installation_id: string;
  fcm_token: string;
  is_active: boolean;
  last_seen_at: string;
  last_success_at: string | null;
  last_error_code: string | null;
};

type PushTokenSyncChange = {
  entity_id: string;
  operation: 'insert' | 'update';
  payload: {
    token_id: string;
    installation_id: string;
    token_hash: string;
    is_active: boolean;
    last_seen_at: string;
    last_success_at: string | null;
    last_error_code: string | null;
  };
};

@Injectable()
export class InstallationsService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly supabaseSyncService: SupabaseSyncService,
  ) {}

  async register(dto: RegisterInstallationDto) {
    this.ensureDatabaseConfigured();

    const installationId = randomUUID();
    const installationToken = randomUUID();
    const now = TimeUtil.getNowInKyiv();

    await this.databaseService.withTransaction(async (client) => {
      await client.query(
        `
          INSERT INTO device_installations (
            installation_id,
            installation_token_hash,
            platform,
            locale,
            app_version,
            app_build,
            device_model,
            notifications_enabled,
            android_id,
            status,
            created_at,
            last_seen_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', $10, $10)
        `,
        [
          installationId,
          this.hashToken(installationToken),
          dto.platform,
          dto.locale,
          dto.app_version,
          dto.app_build,
          dto.device_model,
          dto.notifications_enabled ?? true,
          dto.android_id ?? null,
          now,
        ],
      );

      const devicePayload = await this.loadDevicePayload(client, installationId);
      const pushTokenChanges = await this.persistPushToken(client, installationId, dto.fcm_token, now);

      await this.supabaseSyncService.enqueueEntity(client, {
        entity_type: 'devices',
        entity_id: installationId,
        operation: 'insert',
        payload: devicePayload,
      });

      for (const change of pushTokenChanges) {
        await this.supabaseSyncService.enqueueEntity(client, {
          entity_type: 'device_push_tokens',
          entity_id: change.entity_id,
          operation: change.operation,
          payload: change.payload,
        });
      }
    });

    return {
      installation_id: installationId,
      installation_token: installationToken,
      locale: dto.locale,
      server_time: now,
      push_defaults: {
        notify_on_start: true,
        notify_on_end: true,
      },
    };
  }

  async update(token: string, dto: UpdateInstallationDto) {
    const installation = await this.requireByToken(token);
    const now = TimeUtil.getNowInKyiv();

    await this.databaseService.withTransaction(async (client) => {
      await client.query(
        `
          UPDATE device_installations
          SET app_version = COALESCE($2, app_version),
              app_build = COALESCE($3, app_build),
              notifications_enabled = COALESCE($4, notifications_enabled),
              last_seen_at = $5
          WHERE installation_id = $1
        `,
        [
          installation.installation_id,
          dto.app_version ?? null,
          dto.app_build ?? null,
          dto.notifications_enabled ?? null,
          now,
        ],
      );

      await this.supabaseSyncService.enqueueEntity(client, {
        entity_type: 'devices',
        entity_id: installation.installation_id,
        operation: 'update',
        payload: await this.loadDevicePayload(client, installation.installation_id),
      });
    });

    return {
      installation_id: installation.installation_id,
      updated_at: now,
    };
  }

  async updatePushToken(token: string, fcmToken: string) {
    const installation = await this.requireByToken(token);
    const now = TimeUtil.getNowInKyiv();

    if (!fcmToken.trim()) {
      throw new BadRequestException('FCM token не може бути порожнім.');
    }

    await this.databaseService.withTransaction(async (client) => {
      await client.query(
        `
          UPDATE device_installations
          SET last_seen_at = $2
          WHERE installation_id = $1
        `,
        [installation.installation_id, now],
      );

      const pushTokenChanges = await this.persistPushToken(
        client,
        installation.installation_id,
        fcmToken,
        now,
      );

      await this.supabaseSyncService.enqueueEntity(client, {
        entity_type: 'devices',
        entity_id: installation.installation_id,
        operation: 'update',
        payload: await this.loadDevicePayload(client, installation.installation_id),
      });

      for (const change of pushTokenChanges) {
        await this.supabaseSyncService.enqueueEntity(client, {
          entity_type: 'device_push_tokens',
          entity_id: change.entity_id,
          operation: change.operation,
          payload: change.payload,
        });
      }
    });

    return {
      token_status: 'updated',
      updated_at: now,
    };
  }

  async requireByToken(token: string): Promise<InstallationIdentity> {
    this.ensureDatabaseConfigured();

    if (!token.trim()) {
      throw new UnauthorizedException('Невірний токен встановлення.');
    }

    const result = await this.databaseService.query<InstallationIdentity>(
      `
        SELECT installation_id,
               platform,
               locale,
               app_version,
               app_build,
               device_model,
               notifications_enabled,
               status,
               last_seen_at::text
        FROM device_installations
        WHERE installation_token_hash = $1
          AND status = 'active'
        LIMIT 1
      `,
      [this.hashToken(token)],
    );

    if (result.rowCount === 0) {
      throw new UnauthorizedException('Встановлення не знайдено.');
    }

    return result.rows[0];
  }

  private async persistPushToken(
    client: PoolClient,
    installationId: string,
    fcmToken: string,
    now: string,
  ) {
    const normalizedToken = fcmToken.trim();
    if (!normalizedToken) {
      return [] as PushTokenSyncChange[];
    }

    const changes: PushTokenSyncChange[] = [];
    const deactivatedTokens = await client.query<PushTokenSyncRow>(
      `
        UPDATE device_push_tokens
        SET is_active = FALSE
        WHERE installation_id = $1
          AND fcm_token <> $2
        RETURNING token_id,
                  installation_id,
                  fcm_token,
                  is_active,
                  last_seen_at::text,
                  last_success_at::text,
                  last_error_code
      `,
      [installationId, normalizedToken],
    );

    for (const row of deactivatedTokens.rows) {
      changes.push({
        entity_id: row.token_id,
        operation: 'update',
        payload: this.mapPushTokenPayload(row),
      });
    }

    const existingTokenResult = await client.query<{ token_id: string; installation_id: string }>(
      `
        SELECT token_id, installation_id
        FROM device_push_tokens
        WHERE fcm_token = $1
        FOR UPDATE
      `,
      [normalizedToken],
    );

    if (existingTokenResult.rowCount === 0) {
      const insertedTokenResult = await client.query<PushTokenSyncRow>(
        `
          INSERT INTO device_push_tokens (
            token_id,
            installation_id,
            fcm_token,
            is_active,
            last_seen_at,
            last_success_at,
            last_error_at,
            last_error_code
          ) VALUES ($1, $2, $3, TRUE, $4, NULL, NULL, NULL)
          RETURNING token_id,
                    installation_id,
                    fcm_token,
                    is_active,
                    last_seen_at::text,
                    last_success_at::text,
                    last_error_code
        `,
        [randomUUID(), installationId, normalizedToken, now],
      );

      changes.push({
        entity_id: insertedTokenResult.rows[0].token_id,
        operation: 'insert',
        payload: this.mapPushTokenPayload(insertedTokenResult.rows[0]),
      });

      return changes;
    }

    const oldInstallationId = existingTokenResult.rows[0].installation_id;
    if (oldInstallationId !== installationId) {
      // The FCM token is being reclaimed by a new installation (e.g. app reinstall).
      // Check if the old installation has the same android_id - if so, migrate subscriptions instead of deleting.
      const oldInstallationResult = await client.query<{ android_id: string | null }>(
        `SELECT android_id FROM device_installations WHERE installation_id = $1`,
        [oldInstallationId],
      );

      const oldAndroidId = oldInstallationResult.rows[0]?.android_id;
      const newInstallationResult = await client.query<{ android_id: string | null }>(
        `SELECT android_id FROM device_installations WHERE installation_id = $1`,
        [installationId],
      );
      const newAndroidId = newInstallationResult.rows[0]?.android_id;

      // If android_id matches (both exist and are equal), migrate subscriptions to new installation
      if (oldAndroidId && newAndroidId && oldAndroidId === newAndroidId) {
        await client.query(
          `
            UPDATE subscriptions
            SET installation_id = $1
            WHERE installation_id = $2
          `,
          [installationId, oldInstallationId],
        );
      } else {
        // Different device or no android_id - delete old subscriptions as before
        const deletedSubs = await client.query<{ subscription_id: string }>(
          `
            DELETE FROM subscriptions
            WHERE installation_id = $1
            RETURNING subscription_id
          `,
          [oldInstallationId],
        );

        for (const row of deletedSubs.rows) {
          await this.supabaseSyncService.enqueueEntity(client, {
            entity_type: 'subscriptions',
            entity_id: row.subscription_id,
            operation: 'delete',
            payload: { subscription_id: row.subscription_id },
          });
        }
      }

      await client.query(
        `UPDATE device_installations SET status = 'replaced' WHERE installation_id = $1`,
        [oldInstallationId],
      );
    }

    const updatedTokenResult = await client.query<PushTokenSyncRow>(
      `
        UPDATE device_push_tokens
        SET installation_id = $2,
            is_active = TRUE,
            last_seen_at = $3,
            last_error_at = NULL,
            last_error_code = NULL
        WHERE token_id = $1
        RETURNING token_id,
                  installation_id,
                  fcm_token,
                  is_active,
                  last_seen_at::text,
                  last_success_at::text,
                  last_error_code
      `,
      [existingTokenResult.rows[0].token_id, installationId, now],
    );

    changes.push({
      entity_id: updatedTokenResult.rows[0].token_id,
      operation: 'update',
      payload: this.mapPushTokenPayload(updatedTokenResult.rows[0]),
    });

    return changes;
  }

  private async loadDevicePayload(client: PoolClient, installationId: string) {
    const result = await client.query<DeviceSyncRow>(
      `
        SELECT installation_id,
               platform,
               locale,
               app_version,
               status,
               created_at::text,
               last_seen_at::text
        FROM device_installations
        WHERE installation_id = $1
        LIMIT 1
      `,
      [installationId],
    );

    return result.rows[0];
  }

  private mapPushTokenPayload(row: PushTokenSyncRow) {
    return {
      token_id: row.token_id,
      installation_id: row.installation_id,
      token_hash: this.supabaseSyncService.hashPushToken(row.fcm_token),
      is_active: row.is_active,
      last_seen_at: row.last_seen_at,
      last_success_at: row.last_success_at,
      last_error_code: row.last_error_code,
    };
  }

  private ensureDatabaseConfigured() {
    if (!this.databaseService.isConfigured()) {
      throw new Error('DATABASE_URL is not configured.');
    }
  }

  private hashToken(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }
}
