import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { TelegramIngestService } from '../modules/telegram/telegram-ingest.service';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const service = app.get(TelegramIngestService);
    const result = await service.pollChannels();
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await app.close();
  }
}

void main();
