import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, readFileSync } from 'fs';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging, type Messaging } from 'firebase-admin/messaging';
import { DatabaseService } from '../../common/database/database.service';
import { TimeUtil } from '../../common/utils/time.util';

type DispatchRow = {
  dispatch_id: string;
  subscription_id: string;
  installation_id: string;
  token_id: string;
  event_id: string | null;
  dispatch_kind: 'start' | 'end' | 'level_changed';
  alert_level: string;
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

const MAX_ATTEMPTS = 4;

// Бюджет на один запуск воркера: systemd TimeoutStartSec=120, оставляем
// запас на shutdown и запись статусов.
const RUN_BUDGET_MS = 90_000;

// Коды FCM, при которых сообщение имеет смысл повторить позже.
const RETRIABLE_PROVIDER_CODES = new Set([
  'messaging/server-unavailable',
  'messaging/internal-error',
  'messaging/message-rate-exceeded',
  'messaging/topic-rate-exceeded',
  'messaging/network-error',
  'messaging/unavailable',
  'firebase_send_failed',
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'fetch failed',
]);

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly databaseService: DatabaseService,
  ) {}

  async processQueuedDispatches(limit = 500) {
    if (!this.databaseService.isConfigured()) {
      throw new Error('DATABASE_URL is not configured.');
    }

    const queuedPending = await this.countQueued();
    if (queuedPending === 0) {
      return {
        worker: 'push',
        status: 'idle',
        processed: 0,
        sent: 0,
        failed: 0,
        retried: 0,
        skipped: 0,
        batches: 0,
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

    // Дренаж-цикл: раньше один запуск сливал максимум 500 dispatch
    // (2000/мин при таймере 15 c) — общенациональная тревога на тысячах
    // подписок копила очередь быстрее, чем она уходила, и «отбой»
    // доставлялся с опозданием в минуты. Теперь воркер в рамках своего
    // таймаута повторяет батчи, пока очередь не опустеет.
    const startedAt = Date.now();
    let processed = 0;
    let sent = 0;
    let failed = 0;
    let retried = 0;
    let skipped = 0;
    let batches = 0;
    let lastBatchSize: number;

    do {
      const dispatchesResult = await this.databaseService.query<DispatchRow>(
        `
          SELECT nd.dispatch_id,
                 nd.subscription_id,
                 nd.installation_id,
                 nd.token_id,
                 nd.event_id,
                 nd.dispatch_kind,
                 nd.alert_level,
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
            AND nd.attempt_no < ${MAX_ATTEMPTS}
          ORDER BY nd.queued_at ASC
          LIMIT $1
        `,
        [limit],
      );
      lastBatchSize = dispatchesResult.rows.length;

      if (lastBatchSize === 0) break;

      const outcome = await this.sendBatch(messaging, dispatchesResult.rows);
      processed += lastBatchSize;
      sent += outcome.sent;
      failed += outcome.failed;
      retried += outcome.retried;
      skipped += outcome.skipped;
      batches += 1;
    } while (lastBatchSize === limit && Date.now() - startedAt < RUN_BUDGET_MS);

    if (batches > 1) {
      this.logger.log(
        `Drained ${batches} batches: processed=${processed}, sent=${sent}, failed=${failed}, retried=${retried}, skipped=${skipped}`,
      );
    }

    return {
      worker: 'push',
      status: 'processed',
      processed,
      sent,
      failed,
      retried,
      skipped,
      batches,
      queued_pending: await this.countQueued(),
    };
  }

  private async countQueued(): Promise<number> {
    const pendingResult = await this.databaseService.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM notification_dispatches WHERE status = 'queued'",
    );
    return Number(pendingResult.rows[0]?.count ?? 0);
  }

  private async sendBatch(
    messaging: Messaging,
    rows: DispatchRow[],
  ): Promise<{ sent: number; failed: number; retried: number; skipped: number }> {
    const sentIds: string[] = [];
    const sentMessageIds: string[] = [];
    const sentTokenIds: string[] = [];
    const skippedIds: string[] = [];
    const sendable: DispatchRow[] = [];

    for (const dispatch of rows) {
      if (
        !dispatch.token_active ||
        !dispatch.subscription_active ||
        !dispatch.installation_notifications_enabled ||
        dispatch.installation_status !== 'active'
      ) {
        skippedIds.push(dispatch.dispatch_id);
        continue;
      }
      sendable.push(dispatch);
    }

    let sent = 0;
    let failed = 0;
    let retried = 0;
    const failedRows: Array<{ dispatch: DispatchRow; code: string }> = [];
    const retriedRows: Array<{ dispatch: DispatchRow; code: string }> = [];

    const classify = (dispatch: DispatchRow, code: string) => {
      const retriable =
        this.shouldDeactivateToken(code) === false && this.isRetriableProviderError(code);
      if (retriable && dispatch.attempt_no < MAX_ATTEMPTS) {
        retriedRows.push({ dispatch, code });
      } else {
        failedRows.push({ dispatch, code });
      }
    };

    if (sendable.length > 0) {
      const sentAt = TimeUtil.getNowInKyiv();

      try {
        // Batch send — up to 500 messages per FCM call instead of one
        // HTTP request per token.
        const batchResponse = await messaging.sendEach(
          sendable.map((dispatch) => ({
            token: dispatch.fcm_token,
            notification: {
              title: dispatch.title_uk,
              body: dispatch.body_uk,
            },
            data: {
              subscription_id: dispatch.subscription_id,
              event_id: dispatch.event_id ?? '',
              dispatch_kind: dispatch.dispatch_kind,
              alert_level: dispatch.alert_level,
              sent_at: sentAt,
            },
            android: {
              priority: 'high' as const,
            },
          })),
        );

        for (let index = 0; index < sendable.length; index += 1) {
          const dispatch = sendable[index];
          const response = batchResponse.responses[index];
          if (response?.success) {
            sent += 1;
            sentIds.push(dispatch.dispatch_id);
            sentMessageIds.push(response.messageId ?? '');
            sentTokenIds.push(dispatch.token_id);
          } else {
            classify(dispatch, this.extractProviderErrorCode(response?.error));
          }
        }
      } catch (error) {
        // RPC-level failure — every message in the batch is undelivered.
        // Транзиентная (сеть/5xx): возвращаем в очередь, а не в failed —
        // раньше один сбой посреди массовой тревоги навсегда ронял весь
        // батч (пользователь получал «отбой», не получив «тревогу»).
        const providerErrorCode = this.extractProviderErrorCode(error);
        for (const dispatch of sendable) {
          classify(dispatch, providerErrorCode);
        }
      }
    }

    failed = failedRows.length;
    retried = retriedRows.length;

    // Батч-финализация: раньше каждый dispatch обновлялся отдельной
    // транзакцией (~2 round-trip × 500 на батч).
    await Promise.all([
      skippedIds.length > 0 ? this.markSkippedBatch(skippedIds) : Promise.resolve(),
      sentIds.length > 0
        ? this.markSentBatch(sentIds, sentMessageIds, sentTokenIds)
        : Promise.resolve(),
      failedRows.length > 0 ? this.markFailedBatch(failedRows) : Promise.resolve(),
      retriedRows.length > 0 ? this.markRetriedBatch(retriedRows) : Promise.resolve(),
    ]);

    return { sent, failed, retried, skipped: skippedIds.length };
  }

  private async markSkippedBatch(dispatchIds: string[]) {
    await this.databaseService.query(
      `
        UPDATE notification_dispatches
        SET status = 'skipped',
            provider_error_code = 'RECIPIENT_DISABLED'
        WHERE dispatch_id = ANY($1::uuid[])
      `,
      [dispatchIds],
    );
  }

  private async markSentBatch(dispatchIds: string[], messageIds: string[], tokenIds: string[]) {
    const sentAt = TimeUtil.getNowInKyiv();
    await this.databaseService.query(
      `
        UPDATE notification_dispatches nd
        SET status = 'sent',
            provider_message_id = r.message_id,
            provider_error_code = NULL,
            sent_at = $2
        FROM unnest($1::uuid[], $3::text[]) AS r(dispatch_id, message_id)
        WHERE nd.dispatch_id = r.dispatch_id
      `,
      [dispatchIds, sentAt, messageIds],
    );
    await this.databaseService.query(
      `
        UPDATE device_push_tokens
        SET last_success_at = $2,
            last_error_at = NULL,
            last_error_code = NULL
        WHERE token_id = ANY($1::uuid[])
      `,
      [[...new Set(tokenIds)], sentAt],
    );
  }

  private async markFailedBatch(rows: Array<{ dispatch: DispatchRow; code: string }>) {
    const failedAt = TimeUtil.getNowInKyiv();
    await this.databaseService.query(
      `
        UPDATE notification_dispatches nd
        SET status = 'failed',
            attempt_no = attempt_no + 1,
            provider_error_code = r.code
        FROM unnest($1::uuid[], $2::text[]) AS r(dispatch_id, code)
        WHERE nd.dispatch_id = r.dispatch_id
      `,
      [rows.map((row) => row.dispatch.dispatch_id), rows.map((row) => row.code)],
    );
    await this.databaseService.query(
      `
        UPDATE device_push_tokens dpt
        SET last_error_at = $2,
            last_error_code = r.code,
            is_active = CASE WHEN r.deactivate THEN FALSE ELSE dpt.is_active END
        FROM unnest($1::uuid[], $3::text[], $4::boolean[]) AS r(token_id, code, deactivate)
        WHERE dpt.token_id = r.token_id
      `,
      [
        rows.map((row) => row.dispatch.token_id),
        failedAt,
        rows.map((row) => row.code),
        rows.map((row) => this.shouldDeactivateToken(row.code)),
      ],
    );
  }

  private async markRetriedBatch(rows: Array<{ dispatch: DispatchRow; code: string }>) {
    await this.databaseService.query(
      `
        UPDATE notification_dispatches nd
        SET attempt_no = attempt_no + 1,
            provider_error_code = r.code,
            status = CASE WHEN attempt_no + 1 >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'queued' END
        FROM unnest($1::uuid[], $2::text[]) AS r(dispatch_id, code)
        WHERE nd.dispatch_id = r.dispatch_id
      `,
      [rows.map((row) => row.dispatch.dispatch_id), rows.map((row) => row.code)],
    );
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

  private isRetriableProviderError(providerErrorCode: string) {
    if (RETRIABLE_PROVIDER_CODES.has(providerErrorCode)) {
      return true;
    }
    return /timeout|unavailable|rate-exceeded|network/i.test(providerErrorCode);
  }
}
