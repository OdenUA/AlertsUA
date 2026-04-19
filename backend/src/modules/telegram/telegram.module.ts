import { Module } from '@nestjs/common';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { TelegramIngestService } from './telegram-ingest.service';
import { GeminiThreatParserService } from './gemini-threat-parser.service';

@Module({
  imports: [SubscriptionsModule],
  providers: [TelegramIngestService, GeminiThreatParserService],
  exports: [TelegramIngestService, GeminiThreatParserService],
})
export class TelegramModule {}
