#!/usr/bin/env node
/**
 * Retention worker — ежедневная чистка растущих таблиц.
 * Запускается systemd-таймером alerts-ua-retention.timer.
 *
 * До этого воркера ничто не чистило:
 *  - notification_dispatches (3.7 млн строк на 2026-10-24) — один seq scan
 *    каждые 15 c у push-воркера;
 *  - air_raid_events (1.8 млн) — дельта-эндпоинт и история баннера;
 *  - alert_poll_cycles, llm_parse_jobs + llm_request_response_audit
 *    (каждая строка аудита — полный промпт ~9 КБ).
 *
 * Удаление идёт батчами, чтобы не держать длинные блокировки на горячих
 * таблицах. Все пороги настраиваются переменными окружения.
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { DatabaseService } from '../common/database/database.service';
import { Logger } from '@nestjs/common';

const BATCH_SIZE = 10_000;
const MAX_BATCHES_PER_TABLE = 2000; // предохранитель: 20 млн строк за запуск

type RetentionRule = {
  table: string;
  description: string;
  // Временная колонка отсечки — у таблиц она разная
  // (queued_at / occurred_at / requested_at / created_at)
  tsColumn: string;
  // SQL-условие выбора строк на удаление (подставляется в WHERE)
  where: string;
  retentionDaysEnv: string;
  defaultDays: number;
};

// Порядок важен: notification_dispatches ссылается на air_raid_events
// (ON DELETE CASCADE), поэтому dispatch-уведомления чистим раньше событий.
const RETENTION_RULES: RetentionRule[] = [
  {
    table: 'notification_dispatches',
    description: 'отправленные/проваленные/пропущенные dispatch-уведомления',
    tsColumn: 'queued_at',
    where: "status <> 'queued'",
    retentionDaysEnv: 'RETENTION_DISPATCHES_DAYS',
    defaultDays: 30,
  },
  {
    table: 'air_raid_events',
    description: 'история событий тревог (баннеру нужно окно 4 дня — запас кратный)',
    tsColumn: 'occurred_at',
    // threat_vectors.resolved_air_raid_event_id ссылается на события без
    // ON DELETE — такие события пропускаем (их немного: vectors архивируются
    // ежедневно, ссылки остаются только на старые «разрешённые» события)
    where: "NOT EXISTS (SELECT 1 FROM threat_vectors tv WHERE tv.resolved_air_raid_event_id = air_raid_events.event_id)",
    retentionDaysEnv: 'RETENTION_EVENTS_DAYS',
    defaultDays: 90,
  },
  {
    table: 'alert_poll_cycles',
    description: 'аудит poll-циклов',
    tsColumn: 'requested_at',
    where: 'TRUE',
    retentionDaysEnv: 'RETENTION_POLL_CYCLES_DAYS',
    defaultDays: 30,
  },
  {
    table: 'llm_request_response_audit',
    description: 'полные логи LLM-запросов (тяжёлые: ~9 КБ на строку)',
    tsColumn: 'created_at',
    where: 'TRUE',
    retentionDaysEnv: 'RETENTION_LLM_AUDIT_DAYS',
    defaultDays: 30,
  },
  {
    table: 'llm_parse_jobs',
    description: 'задачи LLM-парсинга (живую очередь не трогаем)',
    tsColumn: 'created_at',
    where: "status IN ('success', 'failed', 'manual_review')",
    retentionDaysEnv: 'RETENTION_LLM_JOBS_DAYS',
    defaultDays: 30,
  },
];

async function expireStuckQueued(
  databaseService: DatabaseService,
  logger: Logger,
): Promise<number> {
  const expireDays = Number(process.env.RETENTION_DISPATCH_STUCK_DAYS ?? 7);
  const result = await databaseService.query(
    `
      UPDATE notification_dispatches
      SET status = 'failed',
          provider_error_code = 'EXPIRED_STUCK'
      WHERE status = 'queued'
        AND queued_at < NOW() - ($1 || ' days')::interval
        AND attempt_no >= 4
    `,
    [String(expireDays)],
  );
  const count = result.rowCount ?? 0;
  if (count > 0) {
    logger.log(`Expired ${count} stuck queued dispatches (queued > ${expireDays}d, attempts exhausted)`);
  }
  return count;
}

async function run() {
  const logger = new Logger('RetentionWorker');

  try {
    const app = await NestFactory.createApplicationContext(AppModule, {
      logger: ['error', 'warn', 'log'],
    });

    const databaseService = app.get(DatabaseService);

    if (!databaseService.isConfigured()) {
      throw new Error('DATABASE_URL is not configured.');
    }

    await expireStuckQueued(databaseService, logger);

    const summary: Record<string, number> = {};

    for (const rule of RETENTION_RULES) {
      const days = Number(process.env[rule.retentionDaysEnv] ?? rule.defaultDays);
      let totalDeleted = 0;

      for (let batch = 0; batch < MAX_BATCHES_PER_TABLE; batch += 1) {
        const result = await databaseService.query(
          `
            DELETE FROM ${rule.table}
            WHERE ctid IN (
              SELECT ctid FROM ${rule.table}
              WHERE ${rule.where}
                AND ${rule.tsColumn} < NOW() - ($1 || ' days')::interval
              LIMIT ${BATCH_SIZE}
            )
          `,
          [String(days)],
        );
        totalDeleted += result.rowCount ?? 0;
        if ((result.rowCount ?? 0) < BATCH_SIZE) break;
      }

      summary[rule.table] = totalDeleted;
      if (totalDeleted > 0) {
        logger.log(`${rule.table}: deleted ${totalDeleted} rows older than ${days}d (${rule.description})`);
      }
    }

    logger.log(`Retention completed: ${JSON.stringify(summary)}`);

    await app.close();
    process.exit(0);
  } catch (error) {
    logger.error('Retention worker failed:', error);
    process.exit(1);
  }
}

void run();
