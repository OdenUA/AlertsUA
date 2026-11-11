import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { hostname } from 'os';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging, type Messaging } from 'firebase-admin/messaging';
import { DatabaseService } from '../../common/database/database.service';
import { TimeUtil } from '../../common/utils/time.util';

type DispatchKind = 'start' | 'end' | 'level_changed';

type DispatchRow = {
  dispatch_id: string;
  subscription_id: string;
  installation_id: string;
  token_id: string;
  event_id: string | null;
  state_version: string | null;
  dispatch_kind: DispatchKind;
  alert_level: string;
  title_uk: string;
  body_uk: string;
  attempt_no: number;
  queued_at: string;
  expires_at: string | null;
  claim_id: string;
  fcm_token: string;
  token_active: boolean;
  installation_notifications_enabled: boolean;
  installation_status: string;
  subscription_active: boolean;
  notify_on_start: boolean;
  notify_on_end: boolean;
};

type ProviderFailure = {
  dispatch: DispatchRow;
  code: string;
  error: unknown;
};

type BatchOutcome = {
  sent: number;
  failed: number;
  retried: number;
  skipped: number;
  expired: number;
  error_codes: Record<string, number>;
};

const MAX_ATTEMPTS = 4;
const MAX_FCM_BATCH_SIZE = 500;

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
  private readonly ownerId = `${hostname()}:${process.pid}:${randomUUID()}`;
  private messagingClient: Messaging | null = null;
  private rateTokens = -1;
  private rateLastRefillAt = Date.now();
  private readonly rateStartedAt = Date.now();
  private rateBlockedUntil = 0;

  constructor(
    private readonly configService: ConfigService,
    private readonly databaseService: DatabaseService,
  ) {}

  async run(shouldStop: () => boolean) {
    const concurrency = Math.max(1, Math.min(16, this.readPositiveNumber('PUSH_WORKER_CONCURRENCY', 2)));
    await Promise.all(
      Array.from({ length: concurrency }, (_, index) => this.runLane(index + 1, shouldStop)),
    );
  }

  async processQueuedDispatches(limit = MAX_FCM_BATCH_SIZE) {
    const aggregate = {
      worker: 'push',
      status: 'idle',
      processed: 0,
      sent: 0,
      failed: 0,
      retried: 0,
      skipped: 0,
      expired: 0,
      batches: 0,
    };

    while (true) {
      const result = await this.processNextBatch(limit);
      if (result.disabled) {
        return { ...aggregate, status: 'disabled', reason: 'firebase_admin_credentials_missing' };
      }
      if (result.processed === 0) break;

      aggregate.processed += result.processed;
      aggregate.sent += result.sent;
      aggregate.failed += result.failed;
      aggregate.retried += result.retried;
      aggregate.skipped += result.skipped;
      aggregate.expired += result.expired;
      aggregate.batches += 1;
    }

    aggregate.status = aggregate.batches > 0 ? 'processed' : 'idle';
    return aggregate;
  }

  async processNextBatch(limit?: number) {
    if (!this.databaseService.isConfigured()) {
      throw new Error('DATABASE_URL is not configured.');
    }

    const configuredLimit = this.readPositiveNumber('PUSH_BATCH_SIZE', limit ?? MAX_FCM_BATCH_SIZE);
    const batchSize = Math.max(1, Math.min(MAX_FCM_BATCH_SIZE, Math.floor(configuredLimit)));
    const messaging = this.resolveMessagingClient();
    if (!messaging || Date.now() < this.rateBlockedUntil) {
      return {
        processed: 0,
        sent: 0,
        failed: 0,
        retried: 0,
        skipped: 0,
        expired: 0,
        disabled: !messaging,
        idle: true,
      };
    }

    const startedAt = Date.now();
    await Promise.all([this.expireQueued(), this.recoverExpiredClaims()]);
    const rows = await this.claimBatch(batchSize);
    if (rows.length === 0) {
      return {
        processed: 0,
        sent: 0,
        failed: 0,
        retried: 0,
        skipped: 0,
        expired: 0,
        disabled: false,
        idle: true,
      };
    }

    const claimId = rows[0].claim_id;
    const stopHeartbeat = this.startClaimHeartbeat(claimId);
    let outcome: BatchOutcome;
    try {
      outcome = await this.sendBatch(messaging, rows);
    } finally {
      await stopHeartbeat();
    }

    this.logger.log(JSON.stringify({
      event: 'push_batch',
      processed: rows.length,
      ...outcome,
      duration_ms: Date.now() - startedAt,
      claim_id: claimId,
    }));

    return {
      processed: rows.length,
      ...outcome,
      disabled: false,
      idle: false,
    };
  }

  private async runLane(lane: number, shouldStop: () => boolean) {
    while (!shouldStop()) {
      try {
        const result = await this.processNextBatch();
        if (result.disabled) {
          await this.sleep(60_000, shouldStop);
        } else if (result.idle) {
          await this.sleep(this.readPositiveNumber('PUSH_IDLE_POLL_MS', 1000), shouldStop);
        }
      } catch (error) {
        this.logger.error(
          `Push lane ${lane} failed`,
          error instanceof Error ? error.stack : String(error),
        );
        await this.sleep(this.readPositiveNumber('PUSH_IDLE_POLL_MS', 1000), shouldStop);
      }
    }
  }

  private async claimBatch(limit: number) {
    const claimId = randomUUID();
    const result = await this.databaseService.query<DispatchRow>(
      `
        WITH picked AS (
          SELECT nd.dispatch_id
          FROM notification_dispatches nd
          WHERE nd.status = 'queued'
            AND nd.next_attempt_at <= NOW()
            AND (nd.expires_at IS NULL OR nd.expires_at > NOW())
            AND nd.attempt_no < ${MAX_ATTEMPTS}
          ORDER BY nd.priority ASC, nd.next_attempt_at ASC, nd.queued_at ASC
          FOR UPDATE OF nd SKIP LOCKED
          LIMIT $1
        ), claimed AS (
          UPDATE notification_dispatches nd
          SET status = 'sending',
              claim_id = $2,
              claimed_by = $3,
              claimed_at = NOW()
          FROM picked
          WHERE nd.dispatch_id = picked.dispatch_id
          RETURNING nd.*
        )
        SELECT nd.dispatch_id,
               nd.subscription_id,
               nd.installation_id,
               nd.token_id,
               nd.event_id,
               nd.state_version::text,
               nd.dispatch_kind,
               nd.alert_level,
               nd.title_uk,
               nd.body_uk,
               nd.attempt_no,
               nd.queued_at::text,
               nd.expires_at::text,
               nd.claim_id::text,
               dpt.fcm_token,
               dpt.is_active AS token_active,
               di.notifications_enabled AS installation_notifications_enabled,
               di.status AS installation_status,
               s.is_active AS subscription_active,
               s.notify_on_start,
               s.notify_on_end
        FROM claimed nd
        JOIN device_push_tokens dpt ON dpt.token_id = nd.token_id
        JOIN device_installations di ON di.installation_id = nd.installation_id
        JOIN subscriptions s ON s.subscription_id = nd.subscription_id
      `,
      [limit, claimId, this.ownerId],
    );
    return result.rows;
  }

  private async expireQueued() {
    await this.databaseService.query(
      `
        UPDATE notification_dispatches
        SET status = 'expired',
            provider_error_code = 'EXPIRED_IN_QUEUE'
        WHERE status = 'queued'
          AND expires_at IS NOT NULL
          AND expires_at <= NOW()
      `,
    );
  }

  private async recoverExpiredClaims() {
    const leaseMs = this.readPositiveNumber('PUSH_CLAIM_LEASE_MS', 120_000);
    await this.databaseService.query(
      `
        UPDATE notification_dispatches
        SET status = CASE WHEN attempt_no + 1 >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'queued' END,
            attempt_no = attempt_no + 1,
            provider_error_code = 'CLAIM_LEASE_EXPIRED',
            next_attempt_at = CASE
              WHEN attempt_no + 1 >= ${MAX_ATTEMPTS} THEN next_attempt_at
              ELSE NOW() + INTERVAL '30 seconds'
            END,
            claimed_at = NULL,
            claimed_by = NULL,
            claim_id = NULL
        WHERE status = 'sending'
          AND claimed_at < NOW() - ($1 || ' milliseconds')::interval
      `,
      [String(leaseMs)],
    );
  }

  private startClaimHeartbeat(claimId: string) {
    const leaseMs = this.readPositiveNumber('PUSH_CLAIM_LEASE_MS', 120_000);
    let inFlight: Promise<void> | null = null;
    const timer = setInterval(() => {
      if (inFlight) return;
      inFlight = this.databaseService.query(
        `
          UPDATE notification_dispatches
          SET claimed_at = NOW()
          WHERE status = 'sending'
            AND claimed_by = $1
            AND claim_id = $2
        `,
        [this.ownerId, claimId],
      ).then(() => undefined).catch((error) => {
        this.logger.warn(`Claim heartbeat failed: ${this.errorMessage(error)}`);
      }).finally(() => {
        inFlight = null;
      });
    }, Math.max(1000, Math.floor(leaseMs / 3)));

    return async () => {
      clearInterval(timer);
      if (inFlight) await inFlight;
    };
  }

  private async sendBatch(messaging: Messaging, rows: DispatchRow[]): Promise<BatchOutcome> {
    const claimId = rows[0].claim_id;
    const sentIds: string[] = [];
    const sentMessageIds: string[] = [];
    const sentTokenIds: string[] = [];
    const skippedIds: string[] = [];
    const expiredIds: string[] = [];
    const sendable: DispatchRow[] = [];
    const failedRows: ProviderFailure[] = [];
    const retriedRows: ProviderFailure[] = [];
    const errorCodes: Record<string, number> = {};

    for (const dispatch of rows) {
      if (this.remainingTtlMs(dispatch) <= 0) {
        expiredIds.push(dispatch.dispatch_id);
        continue;
      }
      if (
        !dispatch.token_active ||
        !dispatch.subscription_active ||
        !dispatch.installation_notifications_enabled ||
        dispatch.installation_status !== 'active' ||
        (dispatch.dispatch_kind === 'start' && !dispatch.notify_on_start) ||
        (dispatch.dispatch_kind === 'end' && !dispatch.notify_on_end)
      ) {
        skippedIds.push(dispatch.dispatch_id);
        continue;
      }
      sendable.push(dispatch);
    }

    const classify = (dispatch: DispatchRow, code: string, error: unknown) => {
      errorCodes[code] = (errorCodes[code] ?? 0) + 1;
      if (code.includes('rate-exceeded')) {
        this.rateBlockedUntil = Math.max(
          this.rateBlockedUntil,
          Date.now() + (this.extractRetryAfterMs(error) ?? 60_000),
        );
      }
      const retriable = !this.shouldDeactivateToken(code) && this.isRetriableProviderError(code);
      if (retriable && dispatch.attempt_no < MAX_ATTEMPTS) {
        retriedRows.push({ dispatch, code, error });
      } else {
        failedRows.push({ dispatch, code, error });
      }
    };

    if (sendable.length > 0) {
      await this.waitForFcmPermit(sendable.length);
      const readyToSend = sendable.filter((dispatch) => this.remainingTtlMs(dispatch) > 0);
      for (const dispatch of sendable) {
        if (!readyToSend.includes(dispatch)) expiredIds.push(dispatch.dispatch_id);
      }

      if (readyToSend.length > 0) {
        const sentAt = TimeUtil.getNowInKyiv();
        try {
          const batchResponse = await messaging.sendEach(
            readyToSend.map((dispatch) => ({
              token: dispatch.fcm_token,
              notification: {
                title: dispatch.title_uk,
                body: dispatch.body_uk,
              },
              data: {
                dispatch_id: dispatch.dispatch_id,
                subscription_id: dispatch.subscription_id,
                event_id: dispatch.event_id ?? '',
                state_version: dispatch.state_version ?? '',
                dispatch_kind: dispatch.dispatch_kind,
                alert_level: dispatch.alert_level,
                sent_at: sentAt,
              },
              android: {
                priority: 'high' as const,
                ttl: this.remainingTtlMs(dispatch),
                notification: {
                  tag: `alert_${dispatch.subscription_id}`,
                },
              },
            })),
          );

          for (let index = 0; index < readyToSend.length; index += 1) {
            const dispatch = readyToSend[index];
            const response = batchResponse.responses[index];
            if (response?.success) {
              sentIds.push(dispatch.dispatch_id);
              sentMessageIds.push(response.messageId ?? '');
              sentTokenIds.push(dispatch.token_id);
            } else {
              classify(dispatch, this.extractProviderErrorCode(response?.error), response?.error);
            }
          }
        } catch (error) {
          const providerErrorCode = this.extractProviderErrorCode(error);
          for (const dispatch of readyToSend) {
            classify(dispatch, providerErrorCode, error);
          }
        }
      }
    }

    await Promise.all([
      skippedIds.length > 0 ? this.markSkippedBatch(skippedIds, claimId) : Promise.resolve(),
      expiredIds.length > 0 ? this.markExpiredBatch(expiredIds, claimId) : Promise.resolve(),
      sentIds.length > 0
        ? this.markSentBatch(sentIds, sentMessageIds, sentTokenIds, claimId)
        : Promise.resolve(),
      failedRows.length > 0 ? this.markFailedBatch(failedRows, claimId) : Promise.resolve(),
      retriedRows.length > 0 ? this.markRetriedBatch(retriedRows, claimId) : Promise.resolve(),
    ]);

    return {
      sent: sentIds.length,
      failed: failedRows.length,
      retried: retriedRows.length,
      skipped: skippedIds.length,
      expired: expiredIds.length,
      error_codes: errorCodes,
    };
  }

  private async markSkippedBatch(dispatchIds: string[], claimId: string) {
    await this.databaseService.query(
      `
        UPDATE notification_dispatches
        SET status = 'skipped',
            provider_error_code = 'RECIPIENT_DISABLED',
            claimed_at = NULL, claimed_by = NULL, claim_id = NULL
        WHERE dispatch_id = ANY($1::uuid[])
          AND status = 'sending'
          AND claim_id = $2
      `,
      [dispatchIds, claimId],
    );
  }

  private async markExpiredBatch(dispatchIds: string[], claimId: string) {
    await this.databaseService.query(
      `
        UPDATE notification_dispatches
        SET status = 'expired',
            provider_error_code = 'EXPIRED_BEFORE_SEND',
            claimed_at = NULL, claimed_by = NULL, claim_id = NULL
        WHERE dispatch_id = ANY($1::uuid[])
          AND status = 'sending'
          AND claim_id = $2
      `,
      [dispatchIds, claimId],
    );
  }

  private async markSentBatch(
    dispatchIds: string[],
    messageIds: string[],
    tokenIds: string[],
    claimId: string,
  ) {
    const sentAt = TimeUtil.getNowInKyiv();
    const successUpdateIntervalSeconds = this.readPositiveNumber(
      'PUSH_TOKEN_SUCCESS_UPDATE_INTERVAL_SECONDS',
      3600,
    );
    await this.databaseService.query(
      `
        UPDATE notification_dispatches nd
        SET status = 'sent',
            provider_message_id = r.message_id,
            provider_error_code = NULL,
            sent_at = $2,
            claimed_at = NULL, claimed_by = NULL, claim_id = NULL
        FROM unnest($1::uuid[], $3::text[]) AS r(dispatch_id, message_id)
        WHERE nd.dispatch_id = r.dispatch_id
          AND nd.status = 'sending'
          AND nd.claim_id = $4
      `,
      [dispatchIds, sentAt, messageIds, claimId],
    );
    await this.databaseService.query(
      `
        UPDATE device_push_tokens
        SET last_success_at = CASE
              WHEN last_success_at IS NULL
                OR last_success_at < $2::timestamptz - ($3 || ' seconds')::interval
              THEN $2 ELSE last_success_at
            END,
            last_error_at = NULL,
            last_error_code = NULL
        WHERE token_id = ANY($1::uuid[])
          AND (
            last_success_at IS NULL
            OR last_success_at < $2::timestamptz - ($3 || ' seconds')::interval
            OR last_error_at IS NOT NULL
            OR last_error_code IS NOT NULL
          )
      `,
      [[...new Set(tokenIds)], sentAt, String(successUpdateIntervalSeconds)],
    );
  }

  private async markFailedBatch(rows: ProviderFailure[], claimId: string) {
    const failedAt = TimeUtil.getNowInKyiv();
    await this.databaseService.query(
      `
        UPDATE notification_dispatches nd
        SET status = 'failed',
            attempt_no = attempt_no + 1,
            provider_error_code = r.code,
            claimed_at = NULL, claimed_by = NULL, claim_id = NULL
        FROM unnest($1::uuid[], $2::text[]) AS r(dispatch_id, code)
        WHERE nd.dispatch_id = r.dispatch_id
          AND nd.status = 'sending'
          AND nd.claim_id = $3
      `,
      [rows.map((row) => row.dispatch.dispatch_id), rows.map((row) => row.code), claimId],
    );
    const tokenFailures = new Map<string, { code: string; deactivate: boolean }>();
    for (const row of rows) {
      const deactivate = this.shouldDeactivateToken(row.code);
      const existing = tokenFailures.get(row.dispatch.token_id);
      tokenFailures.set(row.dispatch.token_id, {
        code: row.code,
        deactivate: deactivate || existing?.deactivate === true,
      });
    }
    const uniqueTokenFailures = [...tokenFailures.entries()];
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
        uniqueTokenFailures.map(([tokenId]) => tokenId),
        failedAt,
        uniqueTokenFailures.map(([, row]) => row.code),
        uniqueTokenFailures.map(([, row]) => row.deactivate),
      ],
    );
  }

  private async markRetriedBatch(rows: ProviderFailure[], claimId: string) {
    const nextAttempts = rows.map((row) => new Date(
      Date.now() + this.retryDelayMs(row),
    ).toISOString());
    await this.databaseService.query(
      `
        UPDATE notification_dispatches nd
        SET attempt_no = attempt_no + 1,
            provider_error_code = r.code,
            status = CASE WHEN attempt_no + 1 >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'queued' END,
            next_attempt_at = r.next_attempt_at,
            claimed_at = NULL, claimed_by = NULL, claim_id = NULL
        FROM unnest($1::uuid[], $2::text[], $3::timestamptz[]) AS r(dispatch_id, code, next_attempt_at)
        WHERE nd.dispatch_id = r.dispatch_id
          AND nd.status = 'sending'
          AND nd.claim_id = $4
      `,
      [
        rows.map((row) => row.dispatch.dispatch_id),
        rows.map((row) => row.code),
        nextAttempts,
        claimId,
      ],
    );
  }

  private retryDelayMs(row: ProviderFailure) {
    if (row.code.includes('rate-exceeded')) {
      return this.extractRetryAfterMs(row.error) ?? 60_000;
    }
    const base = Math.min(120_000, 10_000 * (2 ** Math.max(0, row.dispatch.attempt_no - 1)));
    return Math.round(base * (0.8 + Math.random() * 0.4));
  }

  private async waitForFcmPermit(messageCount: number) {
    const maxRate = this.readPositiveNumber('PUSH_FCM_MAX_RPS', 1000);
    const rampMs = this.readPositiveNumber('PUSH_FCM_RAMP_MS', 60_000);
    if (this.rateTokens < 0) this.rateTokens = Math.min(maxRate, messageCount);

    while (true) {
      const blockedMs = this.rateBlockedUntil - Date.now();
      if (blockedMs > 0) {
        await this.sleep(Math.min(blockedMs, 1000));
        continue;
      }

      const now = Date.now();
      const elapsedMs = now - this.rateLastRefillAt;
      const rampProgress = Math.min(1, (now - this.rateStartedAt) / rampMs);
      const currentRate = Math.max(1, maxRate * (0.1 + 0.9 * rampProgress));
      this.rateTokens = Math.min(maxRate, this.rateTokens + elapsedMs * currentRate / 1000);
      this.rateLastRefillAt = now;

      if (this.rateTokens >= messageCount) {
        this.rateTokens -= messageCount;
        return;
      }

      const missing = messageCount - this.rateTokens;
      await this.sleep(Math.max(10, Math.min(1000, missing / currentRate * 1000)));
    }
  }

  private remainingTtlMs(dispatch: DispatchRow) {
    if (!dispatch.expires_at) return 2419200000;
    return Math.max(0, Date.parse(dispatch.expires_at) - Date.now());
  }

  private resolveMessagingClient() {
    if (this.messagingClient) return this.messagingClient;
    const firebaseServiceAccountPath =
      this.configService.get<string>('FIREBASE_SERVICE_ACCOUNT_PATH') ??
      '/srv/alerts-ua/env/firebase-service-account.json';
    if (!existsSync(firebaseServiceAccountPath)) return null;
    this.messagingClient = this.getMessagingClient(firebaseServiceAccountPath);
    return this.messagingClient;
  }

  private getMessagingClient(firebaseServiceAccountPath: string): Messaging {
    const appName = 'alerts-ua-push';
    const existingApp = getApps().find((app) => app.name === appName);
    if (existingApp) return getMessaging(existingApp);

    const serviceAccount = JSON.parse(readFileSync(firebaseServiceAccountPath, 'utf-8'));
    const app = initializeApp({ credential: cert(serviceAccount) }, appName);
    return getMessaging(app);
  }

  private extractProviderErrorCode(error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      return String((error as { code: unknown }).code);
    }
    if (error instanceof Error) return error.name;
    return 'firebase_send_failed';
  }

  private extractRetryAfterMs(error: unknown) {
    if (typeof error !== 'object' || error === null) return null;
    const candidate = error as {
      response?: { headers?: Record<string, string | undefined> };
      errorInfo?: { response?: { headers?: Record<string, string | undefined> } };
    };
    const value = candidate.response?.headers?.['retry-after']
      ?? candidate.errorInfo?.response?.headers?.['retry-after'];
    if (!value) return null;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(value);
    return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
  }

  private shouldDeactivateToken(providerErrorCode: string) {
    return [
      'messaging/registration-token-not-registered',
      'messaging/invalid-registration-token',
    ].includes(providerErrorCode);
  }

  private isRetriableProviderError(providerErrorCode: string) {
    if (RETRIABLE_PROVIDER_CODES.has(providerErrorCode)) return true;
    return /timeout|unavailable|rate-exceeded|network/i.test(providerErrorCode);
  }

  private readPositiveNumber(name: string, defaultValue: number) {
    const configured = Number(this.configService.get<string>(name) ?? defaultValue);
    return Number.isFinite(configured) && configured > 0 ? configured : defaultValue;
  }

  private errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }

  private async sleep(ms: number, shouldStop?: () => boolean) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && !shouldStop?.()) {
      await new Promise<void>((resolve) => setTimeout(
        resolve,
        Math.min(250, Math.max(1, deadline - Date.now())),
      ));
    }
  }
}
