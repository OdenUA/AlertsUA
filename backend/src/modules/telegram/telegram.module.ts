import { Module } from '@nestjs/common';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { CacheModule } from '../../common/cache/cache.module';
import { AlertsModule } from '../alerts/alerts.module';
import { TelegramIngestService } from './telegram-ingest.service';
import { GeminiThreatParserService } from './gemini-threat-parser.service';

@Module({
  imports: [SubscriptionsModule, CacheModule, AlertsModule],
  providers: [TelegramIngestService, GeminiThreatParserService],
  exports: [TelegramIngestService, GeminiThreatParserService],
})
export class TelegramModule {}
