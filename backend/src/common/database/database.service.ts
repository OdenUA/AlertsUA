import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly pool: Pool | null;

  constructor(private readonly configService: ConfigService) {
    const databaseUrl = this.configService.get<string>('DATABASE_URL');
    this.pool = databaseUrl
      ? new Pool({
          connectionString: databaseUrl,
        })
      : null;
  }

  isConfigured() {
    return this.pool !== null;
  }

  async checkHealth() {
    if (!this.pool) {
      return {
        configured: false,
        reachable: false,
      };
    }

    await this.pool.query('SELECT 1');
    return {
      configured: true,
      reachable: true,
    };
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<T>> {
    if (!this.pool) {
      throw new Error('DATABASE_URL is not configured.');
    }

    return this.pool.query<T>(text, values);
  }

  async withTransaction<T>(callback: (client: PoolClient) => Promise<T>) {
    if (!this.pool) {
      throw new Error('DATABASE_URL is not configured.');
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy() {
    await this.pool?.end();
  }
}
