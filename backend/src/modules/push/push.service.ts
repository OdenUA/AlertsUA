import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, readFileSync } from 'fs';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging, type Messaging } from 'firebase-admin/messaging';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../common/database/database.service';
import { SupabaseSyncService } from '../supabase/supabase-sync.service';
import { TimeUtil } from '../../common/utils/time.util';

type DispatchRow = {
  dispatch_id: string;
  subscription_id: string;
  installation_id: string;
  token_id: string;
  event_id: string;
  dispatch_kind: 'start' | 'end';
  title_uk: string;
  body_uk: string;
  attempt_no: number;
  queued_at: string;
  fcm_token: string;
  token_active: boolean;
  installation_notifications_enabled: boolean;
  installation_status: string;
  subscription_active: boolean;
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

@Injectable()
export class PushService {
  constructor(
    private readonly configService: ConfigService,
    private readonly databaseService: DatabaseService,
    private readonly supabaseSyncService: SupabaseSyncService,
  ) {}

  async processQueuedDispatches(limit = 50) {
    if (!this.databaseService.isConfigured()) {
      throw new Error('DATABASE_URL is not configured.');
    }

    const pendingResult = await this.databaseService.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM notification_dispatches WHERE status = 'queued'",
    );
    const queuedPending = Number(pendingResult.rows[0]?.count ?? 0);

    if (queuedPending === 0) {
      return {
        worker: 'push',
        status: 'idle',
        processed: 0,
        sent: 0,
        failed: 0,
        skipped: 0,
        queued_pending: 0,
      };
    }

    const firebaseServiceAccountPath =
      this.configService.get<string>('FIREBASE_SERVICE_ACCOUNT_PATH') ??
      '/srv/alerts-ua/env/firebase-service-account.json';

    if (!existsSync(firebaseServiceAccountPath)) {
      return {
        worker: 'push',
        status: 'disabled',
        reason: 'firebase_admin_credentials_missing',
        queued_pending: queuedPending,
      };
    }

    const messaging = this.getMessagingClient(firebaseServiceAccountPath);
    const dispatchesResult = await this.databaseService.query<DispatchRow>(
      `
        SELECT nd.dispatch_id,
               nd.subscription_id,
               nd.installation_id,
               nd.token_id,
               nd.event_id,
               nd.dispatch_kind,
               nd.title_uk,
               nd.body_uk,
               nd.attempt_no,
               nd.queued_at::text,
               dpt.fcm_token,
               dpt.is_active AS token_active,
               di.notifications_enabled AS installation_notifications_enabled,
               di.status AS installation_status,
               s.is_active AS subscription_active
        FROM notification_dispatches nd
        JOIN device_push_tokens dpt ON dpt.token_id = nd.token_id
        JOIN device_installations di ON di.installation_id = nd.installation_id
        JOIN subscriptions s ON s.subscription_id = nd.subscription_id
        WHERE nd.status = 'queued'
        ORDER BY nd.queued_at ASC
        LIMIT $1
      `,
      [limit],
    );

    let sent = 0;
    let failed = 0;
    let skipped = 0;

    for (const dispatch of dispatchesResult.rows) {
      if (
        !dispatch.token_active ||
        !dispatch.subscription_active ||
        !dispatch.installation_notifications_enabled ||
        dispatch.installation_status !== 'active'
      ) {
        skipped += 1;
        await this.databaseService.withTransaction(async (client) => {
          await client.query(
            `
              UPDATE notification_dispatches
              SET status = 'skipped',
                  provider_error_code = $2
              WHERE dispatch_id = $1
            `,
            [dispatch.dispatch_id, 'RECIPIENT_DISABLED'],
          );

          await this.supabaseSyncService.enqueueEntity(client, {
            entity_type: 'notification_log',
            entity_id: dispatch.dispatch_id,
            operation: 'update',
            payload: {
              dispatch_id: dispatch.dispatch_id,
              subscription_id: dispatch.subscription_id,
              installation_id: dispatch.installation_id,
              event_id: dispatch.event_id,
              dispatch_kind: dispatch.dispatch_kind,
              status: 'skipped',
              provider_message_id: null,
              provider_error_code: 'RECIPIENT_DISABLED',
              queued_at: dispatch.queued_at,
              sent_at: null,
            },
          });
        });
        continue;
      }

      try {
        const sentAt = TimeUtil.getNowInKyiv();
        const messageId = await messaging.send({
          token: dispatch.fcm_token,
          notification: {
            title: dispatch.title_uk,
            body: dispatch.body_uk,
          },
          data: {
            subscription_id: dispatch.subscription_id,
            event_id: dispatch.event_id,
            dispatch_kind: dispatch.dispatch_kind,
            sent_at: sentAt,
          },
          android: {
            priority: 'high',
          },
        });

        sent += 1;
        await this.databaseService.withTransaction(async (client) => {
          await client.query(
            `
              UPDATE notification_dispatches
              SET status = 'sent',
                  provider_message_id = $2,
                  provider_error_code = NULL,
                  sent_at = $3
              WHERE dispatch_id = $1
            `,
            [dispatch.dispatch_id, messageId, sentAt],
          );
          await client.query(
            `
              UPDATE device_push_tokens
              SET last_success_at = $2,
                  last_error_at = NULL,
                  last_error_code = NULL
              WHERE token_id = $1
            `,
            [dispatch.token_id, sentAt],
          );

          await this.supabaseSyncService.enqueueEntity(client, {
            entity_type: 'notification_log',
            entity_id: dispatch.dispatch_id,
            operation: 'update',
            payload: {
              dispatch_id: dispatch.dispatch_id,
              subscription_id: dispatch.subscription_id,
              installation_id: dispatch.installation_id,
              event_id: dispatch.event_id,
              dispatch_kind: dispatch.dispatch_kind,
              status: 'sent',
              provider_message_id: messageId,
              provider_error_code: null,
              queued_at: dispatch.queued_at,
              sent_at: sentAt,
            },
          });

          await this.supabaseSyncService.enqueueEntity(client, {
            entity_type: 'device_push_tokens',
            entity_id: dispatch.token_id,
            operation: 'update',
            payload: await this.loadPushTokenPayload(client, dispatch.token_id),
          });
        });
      } catch (error) {
        failed += 1;
        const providerErrorCode = this.extractProviderErrorCode(error);
        const failedAt = TimeUtil.getNowInKyiv();
        await this.databaseService.withTransaction(async (client) => {
          await client.query(
            `
              UPDATE notification_dispatches
              SET status = 'failed',
                  attempt_no = attempt_no + 1,
                  provider_error_code = $2
              WHERE dispatch_id = $1
            `,
            [dispatch.dispatch_id, providerErrorCode],
          );
          await client.query(
            `
              UPDATE device_push_tokens
              SET last_error_at = $3,
                  last_error_code = $2,
                  is_active = CASE WHEN $4 THEN FALSE ELSE is_active END
              WHERE token_id = $1
            `,
            [
              dispatch.token_id,
              providerErrorCode,
              failedAt,
              this.shouldDeactivateToken(providerErrorCode),
            ],
          );

          await this.supabaseSyncService.enqueueEntity(client, {
            entity_type: 'notification_log',
            entity_id: dispatch.dispatch_id,
            operation: 'update',
            payload: {
              dispatch_id: dispatch.dispatch_id,
              subscription_id: dispatch.subscription_id,
              installation_id: dispatch.installation_id,
              event_id: dispatch.event_id,
              dispatch_kind: dispatch.dispatch_kind,
              status: 'failed',
              provider_message_id: null,
              provider_error_code: providerErrorCode,
              queued_at: dispatch.queued_at,
              sent_at: null,
            },
          });

          await this.supabaseSyncService.enqueueEntity(client, {
            entity_type: 'device_push_tokens',
            entity_id: dispatch.token_id,
            operation: 'update',
            payload: await this.loadPushTokenPayload(client, dispatch.token_id),
          });
        });
      }
    }

    return {
      worker: 'push',
      status: 'processed',
      processed: dispatchesResult.rows.length,
      sent,
      failed,
      skipped,
      queued_pending: Math.max(queuedPending - sent - failed - skipped, 0),
    };
  }

  private getMessagingClient(firebaseServiceAccountPath: string): Messaging {
    const appName = 'alerts-ua-push';
    const existingApp = getApps().find((app) => app.name === appName);
    if (existingApp) {
      return getMessaging(existingApp);
    }

    const serviceAccount = JSON.parse(readFileSync(firebaseServiceAccountPath, 'utf-8'));
    const app = initializeApp(
      {
        credential: cert(serviceAccount),
      },
      appName,
    );
    return getMessaging(app);
  }

  private extractProviderErrorCode(error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      return String((error as { code: unknown }).code);
    }

    if (error instanceof Error) {
      return error.name;
    }

    return 'firebase_send_failed';
  }

  private shouldDeactivateToken(providerErrorCode: string) {
    return [
      'messaging/registration-token-not-registered',
      'messaging/invalid-registration-token',
    ].includes(providerErrorCode);
  }

  private async loadPushTokenPayload(client: PoolClient, tokenId: string) {
    const result = await client.query<PushTokenSyncRow>(
      `
        SELECT token_id,
               installation_id,
               fcm_token,
               is_active,
               last_seen_at::text,
               last_success_at::text,
               last_error_code
        FROM device_push_tokens
        WHERE token_id = $1
        LIMIT 1
      `,
      [tokenId],
    );

    return {
      token_id: result.rows[0].token_id,
      installation_id: result.rows[0].installation_id,
      token_hash: this.supabaseSyncService.hashPushToken(result.rows[0].fcm_token),
      is_active: result.rows[0].is_active,
      last_seen_at: result.rows[0].last_seen_at,
      last_success_at: result.rows[0].last_success_at,
      last_error_code: result.rows[0].last_error_code,
    };
  }
}