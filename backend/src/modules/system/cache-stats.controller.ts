import { Controller, Get } from '@nestjs/common';
import { CacheService } from '../../common/cache/cache.service';

@Controller('system')
export class CacheStatsController {
  constructor(private readonly cacheService: CacheService) {}

  @Get('cache-stats')
  async getCacheStats() {
    const stats = await this.cacheService.getStats();
    return {
      status: 'ok',
      cache: {
        enabled: stats.connected,
        metrics: stats.metrics,
        keys_count: stats.keys_count,
        memory_used: stats.memory_used,
      },
    };
  }
}
