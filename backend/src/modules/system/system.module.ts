import { Module } from '@nestjs/common';
import { CacheModule } from '../../common/cache/cache.module';
import { SystemController } from './system.controller';
import { CacheStatsController } from './cache-stats.controller';

@Module({
  imports: [CacheModule],
  controllers: [SystemController, CacheStatsController],
})
export class SystemModule {}
