import { Controller, Get } from '@nestjs/common';
import { DatabaseService } from '../../common/database/database.service';
import { TimeUtil } from '../../common/utils/time.util';

@Controller('system')
export class SystemController {
  constructor(private readonly databaseService: DatabaseService) {}

  @Get('health')
  async getHealth() {
    const database = await this.databaseService.checkHealth();

    return {
      status: 'ok',
      service: 'alerts-ua-backend',
      version: '0.2.0-TEST',
      timestamp: TimeUtil.getNowInKyiv(),
      database,
    };
  }

  @Get('push-stats')
  async getPushStats() {
    const [queueResult, latencyResult] = await Promise.all([
      this.databaseService.query<{
        queued: number;
        sending: number;
        ready: number;
        retry_scheduled: number;
        expired_pending: number;
        oldest_queued_seconds: string | null;
        oldest_sending_seconds: string | null;
      }>(
        `
          SELECT COUNT(*) FILTER (WHERE status = 'queued')::int AS queued,
                 COUNT(*) FILTER (WHERE status = 'sending')::int AS sending,
                 COUNT(*) FILTER (
                   WHERE status = 'queued'
                     AND next_attempt_at <= NOW()
                     AND (expires_at IS NULL OR expires_at > NOW())
                 )::int AS ready,
                 COUNT(*) FILTER (
                   WHERE status = 'queued' AND next_attempt_at > NOW()
                 )::int AS retry_scheduled,
                 COUNT(*) FILTER (
                   WHERE status = 'queued' AND expires_at <= NOW()
                 )::int AS expired_pending,
                 EXTRACT(EPOCH FROM NOW() - MIN(queued_at) FILTER (WHERE status = 'queued'))::text
                   AS oldest_queued_seconds,
                 EXTRACT(EPOCH FROM NOW() - MIN(claimed_at) FILTER (WHERE status = 'sending'))::text
                   AS oldest_sending_seconds
          FROM notification_dispatches
          WHERE status IN ('queued', 'sending')
        `,
      ),
      this.databaseService.query<{
        dispatch_kind: string;
        sample_count: string;
        p50_seconds: string | null;
        p95_seconds: string | null;
        p99_seconds: string | null;
      }>(
        `
          SELECT dispatch_kind,
                 COUNT(*)::text AS sample_count,
                 percentile_cont(0.50) WITHIN GROUP (
                   ORDER BY EXTRACT(EPOCH FROM sent_at - queued_at)
                 )::text AS p50_seconds,
                 percentile_cont(0.95) WITHIN GROUP (
                   ORDER BY EXTRACT(EPOCH FROM sent_at - queued_at)
                 )::text AS p95_seconds,
                 percentile_cont(0.99) WITHIN GROUP (
                   ORDER BY EXTRACT(EPOCH FROM sent_at - queued_at)
                 )::text AS p99_seconds
          FROM notification_dispatches
          WHERE status = 'sent'
            AND sent_at >= NOW() - INTERVAL '1 hour'
          GROUP BY dispatch_kind
          ORDER BY dispatch_kind
        `,
      ),
    ]);

    const queue = queueResult.rows[0];
    return {
      status: 'ok',
      timestamp: TimeUtil.getNowInKyiv(),
      queue: {
        queued: queue?.queued ?? 0,
        sending: queue?.sending ?? 0,
        ready: queue?.ready ?? 0,
        retry_scheduled: queue?.retry_scheduled ?? 0,
        expired_pending: queue?.expired_pending ?? 0,
        oldest_queued_seconds: Number(queue?.oldest_queued_seconds ?? 0),
        oldest_sending_seconds: Number(queue?.oldest_sending_seconds ?? 0),
      },
      acceptance_latency: {
        window_seconds: 3600,
        note: 'FCM acceptance time, not device delivery time',
        by_kind: latencyResult.rows.map((row) => ({
          dispatch_kind: row.dispatch_kind,
          sample_count: Number(row.sample_count),
          p50_seconds: Number(row.p50_seconds ?? 0),
          p95_seconds: Number(row.p95_seconds ?? 0),
          p99_seconds: Number(row.p99_seconds ?? 0),
        })),
      },
    };
  }
}
