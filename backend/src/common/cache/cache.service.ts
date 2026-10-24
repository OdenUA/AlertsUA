import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { promisify } from 'util';

export interface CacheMetrics {
  hits: number;
  misses: number;
}

@Injectable()
export class CacheService implements OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private redis: Redis | undefined;
  private metrics: CacheMetrics = { hits: 0, misses: 0 };
  private enabled: boolean;

  constructor() {
    const host = process.env.REDIS_HOST || '127.0.0.1';
    const port = parseInt(process.env.REDIS_PORT || '6379');
    const db = parseInt(process.env.REDIS_DB || '3');
    const password = process.env.REDIS_PASSWORD?.trim();
    this.enabled = process.env.CACHE_ENABLED !== 'false';

    this.logger.log(`Redis config: host=${host}, port=${port}, db=${db}, hasPassword=${!!password}`);

    if (!this.enabled) {
      this.logger.warn('Cache is disabled via CACHE_ENABLED=false');
      return;
    }

    try {
      this.redis = new Redis({
        host,
        port,
        db,
        password: password || undefined,
        keyPrefix: 'alerts-ua:map:',
        // Никогда не возвращаем null: null отключает переподключение навсегда,
        // и любой рестарт Redis (>3 попыток по 100-300 мс) оставлял бы API
        // без кэша до следующего процесса.
        retryStrategy: (times) => Math.min(times * 200, 5000),
        maxRetriesPerRequest: 3,
      });

      this.redis.on('error', (err) => {
        this.logger.error(`Redis error: ${err instanceof Error ? err.message : String(err)}`);
      });

      this.redis.on('connect', () => {
        this.logger.log(`Connected to Redis at ${host}:${port}/${db}`);
      });
    } catch (error) {
      this.logger.error(`Failed to initialize Redis: ${error instanceof Error ? error.message : String(error)}`);
      this.enabled = false;
    }
  }

  async onModuleDestroy() {
    if (this.redis) {
      await this.redis.quit();
    }
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.enabled || !this.redis) return null;

    try {
      const value = await this.redis.get(key);
      if (value) {
        this.metrics.hits++;
        return JSON.parse(value) as T;
      }
      this.metrics.misses++;
      return null;
    } catch (error) {
      this.logger.warn(`Cache get failed for key ${key}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  async set(key: string, value: any, ttl?: number): Promise<void> {
    if (!this.enabled || !this.redis) {
      this.logger.warn(`Cache set skipped for key ${key}: enabled=${this.enabled}, redis=${!!this.redis}`);
      return;
    }

    try {
      const json = JSON.stringify(value);
      this.logger.debug(`Cache set: key=${key}, ttl=${ttl}, json_length=${json.length}`);
      if (ttl) {
        await this.redis.setex(key, ttl, json);
      } else {
        await this.redis.set(key, json);
      }
    } catch (error) {
      this.logger.error(`Cache set failed for key ${key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async delete(key: string | string[]): Promise<void> {
    if (!this.enabled || !this.redis) return;

    try {
      const keys = Array.isArray(key) ? key : [key];
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
    } catch (error) {
      this.logger.warn(`Cache delete failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Deletes all keys matching a pattern (e.g. 'resolve-point:*').
   * Uses cursor-based SCAN instead of KEYS: KEYS is O(keyspace) and blocks
   * the single-threaded Redis server, stalling every concurrent cache read.
   * ioredis returns full key names including keyPrefix, while `unlink`
   * prepends the prefix again — so the prefix is stripped before deletion.
   */
  async deleteByPattern(pattern: string): Promise<number> {
    if (!this.enabled || !this.redis) return 0;

    try {
      const prefix = 'alerts-ua:map:';
      let cursor = '0';
      let deleted = 0;
      let batch: string[] = [];

      do {
        const result = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
        cursor = result[0];
        for (const key of result[1]) {
          batch.push(key.startsWith(prefix) ? key.slice(prefix.length) : key);
        }
        if (batch.length >= 500) {
          deleted += await this.redis.unlink(...batch);
          batch = [];
        }
      } while (cursor !== '0');

      if (batch.length > 0) {
        deleted += await this.redis.unlink(...batch);
      }
      return deleted;
    } catch (error) {
      this.logger.warn(`Cache deleteByPattern failed for ${pattern}: ${error instanceof Error ? error.message : String(error)}`);
      return 0;
    }
  }

  async keys(pattern: string): Promise<string[]> {
    if (!this.enabled || !this.redis) return [];

    try {
      const found: string[] = [];
      let cursor = '0';
      do {
        const result = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
        cursor = result[0];
        found.push(...result[1]);
      } while (cursor !== '0');
      return found;
    } catch (error) {
      this.logger.warn(`Cache keys failed for pattern ${pattern}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  async publish(channel: string, message: any): Promise<void> {
    if (!this.enabled || !this.redis) return;

    try {
      await this.redis.publish(channel, JSON.stringify(message));
    } catch (error) {
      this.logger.warn(`Cache publish failed for channel ${channel}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async getOrBuild<T>(
    key: string,
    builder: () => Promise<T>,
    ttl?: number,
  ): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;

    const value = await builder();
    await this.set(key, value, ttl);
    return value;
  }

  async getMetrics(): Promise<CacheMetrics & { hit_rate: number }> {
    const total = this.metrics.hits + this.metrics.misses;
    return {
      ...this.metrics,
      hit_rate: total > 0 ? this.metrics.hits / total : 0,
    };
  }

  async getStats(): Promise<{
    metrics: CacheMetrics & { hit_rate: number };
    keys_count: number;
    memory_used: string;
    connected: boolean;
  }> {
    const metrics = await this.getMetrics();
    let keys_count = 0;
    let memory_used = 'N/A';
    let connected = false;

    if (this.enabled && this.redis) {
      try {
        const info = await this.redis.info('memory');
        const match = info.match(/used_memory_human:([^\r\n]+)/);
        memory_used = match ? match[1] : 'N/A';
        keys_count = await this.redis.dbsize();
        connected = this.redis.status === 'ready';
      } catch (error) {
        this.logger.warn(`Failed to get Redis stats: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return {
      metrics,
      keys_count,
      memory_used,
      connected,
    };
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}
