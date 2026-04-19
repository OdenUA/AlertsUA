import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'crypto';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../common/database/database.service';

type TelegramRawMessage = {
  id?: number;
  date?: number | Date;
  message?: string;
};

type ChannelCursorRow = {
  channel_id: string;
  channel_ref: string;
  last_message_id: string | null;
};

@Injectable()
export class TelegramIngestService implements OnModuleDestroy {
  private readonly logger = new Logger(TelegramIngestService.name);
  private client: TelegramClient | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly databaseService: DatabaseService,
  ) {}

  async onModuleDestroy() {
    if (this.client) {
      await this.client.disconnect();
      this.client = null;
    }
  }

  async pollChannels() {
    if (!this.databaseService.isConfigured()) {
      throw new Error('DATABASE_URL is not configured.');
    }

    const channels = this.getChannelRefs();
    if (channels.length === 0) {
      return {
        polled_channels: 0,
        inserted_messages: 0,
        queued_jobs: 0,
        skipped: true,
        reason: 'TELEGRAM_CHANNEL_REFS is empty.',
      };
    }

    const client = await this.getClient();
    await this.upsertChannels(channels);

    const cursorResult = await this.databaseService.query<ChannelCursorRow>(
      `
        SELECT channel_id, channel_ref, last_message_id::text
        FROM telegram_channels
        WHERE is_active = TRUE
          AND channel_ref = ANY($1::text[])
      `,
      [channels],
    );

    const rowsByRef = new Map(cursorResult.rows.map((row) => [row.channel_ref, row]));
    const perChannel: Array<{
      channel_ref: string;
      fetched_messages: number;
      inserted_messages: number;
      queued_jobs: number;
      last_message_id: number | null;
    }> = [];

    let insertedMessages = 0;
    let queuedJobs = 0;

    for (const channelRef of channels) {
      const cursor = rowsByRef.get(channelRef);
      if (!cursor) {
        continue;
      }

      const sinceId = Number(cursor.last_message_id ?? 0);
      const messages = await this.fetchMessages(client, channelRef, sinceId);

      if (messages.length === 0) {
        perChannel.push({
          channel_ref: channelRef,
          fetched_messages: 0,
          inserted_messages: 0,
          queued_jobs: 0,
          last_message_id: sinceId || null,
        });
        await this.touchChannel(channelRef, sinceId || null);
        continue;
      }

      let insertedForChannel = 0;
      let queuedForChannel = 0;
      let maxSeenMessageId = sinceId;

      for (const message of messages) {
        const messageId = message.id;
        if (!messageId || messageId <= sinceId) {
          continue;
        }

        maxSeenMessageId = Math.max(maxSeenMessageId, messageId);
        const text = (message.message ?? '').trim();
        if (!text) {
          continue;
        }

        const messageDate = this.toDate(message.date);
        const sourceHash = createHash('sha256')
          .update(`${channelRef}:${messageId}:${text}`)
          .digest('hex');

        const inserted = await this.databaseService.withTransaction(async (dbClient) => {
          const rawInsert = await dbClient.query<{ raw_message_id: string }>(
            `
              INSERT INTO telegram_messages_raw (
                channel_id,
                message_id,
                message_date,
                message_text,
                source_hash,
                ingested_at
              ) VALUES ($1, $2, $3, $4, $5, NOW())
              ON CONFLICT (channel_id, message_id) DO NOTHING
              RETURNING raw_message_id::text
            `,
            [channelRef, messageId, messageDate.toISOString(), text, sourceHash],
          );

          const insertedRawId = rawInsert.rows[0]?.raw_message_id;
          if (!insertedRawId) {
            return { inserted: false, queued: false };
          }

          await dbClient.query(
            `
              INSERT INTO llm_parse_jobs (
                job_id,
                raw_message_id,
                status,
                attempt_count,
                created_at,
                updated_at
              ) VALUES ($1, $2, 'pending', 0, NOW(), NOW())
              ON CONFLICT (raw_message_id) DO NOTHING
            `,
            [randomUUID(), insertedRawId],
          );

          return { inserted: true, queued: true };
        });

        if (inserted.inserted) {
          insertedMessages += 1;
          insertedForChannel += 1;
        }
        if (inserted.queued) {
          queuedJobs += 1;
          queuedForChannel += 1;
        }
      }

      await this.touchChannel(channelRef, maxSeenMessageId || null);

      perChannel.push({
        channel_ref: channelRef,
        fetched_messages: messages.length,
        inserted_messages: insertedForChannel,
        queued_jobs: queuedForChannel,
        last_message_id: maxSeenMessageId || null,
      });
    }

    return {
      polled_channels: channels.length,
      inserted_messages: insertedMessages,
      queued_jobs: queuedJobs,
      per_channel: perChannel,
    };
  }

  private getChannelRefs() {
    const raw = this.configService.get<string>('TELEGRAM_CHANNEL_REFS') ?? '';
    return raw
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  }

  private async upsertChannels(channelRefs: string[]) {
    await this.databaseService.query(
      `
        INSERT INTO telegram_channels (channel_id, channel_ref, is_active, created_at, updated_at)
        SELECT value, value, TRUE, NOW(), NOW()
        FROM unnest($1::text[]) AS value
        ON CONFLICT (channel_id) DO UPDATE
        SET is_active = TRUE,
            updated_at = NOW()
      `,
      [channelRefs],
    );
  }

  private async touchChannel(channelRef: string, lastMessageId: number | null) {
    await this.databaseService.query(
      `
        UPDATE telegram_channels
        SET last_message_id = COALESCE($2, last_message_id),
            last_polled_at = NOW(),
            updated_at = NOW()
        WHERE channel_id = $1
      `,
      [channelRef, lastMessageId],
    );
  }

  private async getClient() {
    if (this.client) {
      return this.client;
    }

    const apiIdRaw = this.configService.get<string>('TELEGRAM_API_ID');
    const apiHash = this.configService.get<string>('TELEGRAM_API_HASH');
    const sessionString = this.configService.get<string>('TELEGRAM_SESSION_STRING');

    if (!apiIdRaw || !apiHash || !sessionString) {
      throw new Error(
        'TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION_STRING are required for MTProto ingestion.',
      );
    }

    const apiId = Number(apiIdRaw);
    if (!Number.isFinite(apiId)) {
      throw new Error('TELEGRAM_API_ID must be a valid number.');
    }

    const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
      connectionRetries: 5,
    });
    await client.connect();

    this.client = client;
    this.logger.log('MTProto client is connected.');
    return client;
  }

  private async fetchMessages(client: TelegramClient, channelRef: string, minId: number) {
    const limitRaw = this.configService.get<string>('TELEGRAM_INGEST_LIMIT') ?? '100';
    const limit = Math.min(200, Math.max(20, Number(limitRaw) || 100));

    const entity = await client.getEntity(channelRef);
    const result = await client.getMessages(entity, {
      limit,
      minId,
    });

    const items = Array.from(result as unknown as TelegramRawMessage[])
      .filter((message) => Number.isFinite(message.id))
      .sort((left, right) => Number(left.id ?? 0) - Number(right.id ?? 0));

    return items;
  }

  private toDate(value: number | Date | undefined) {
    if (!value) {
      return new Date();
    }

    if (value instanceof Date) {
      return value;
    }

    const milliseconds = value > 1_000_000_000_000 ? value : value * 1000;
    return new Date(milliseconds);
  }
}
