import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { GeminiThreatParserService } from '../modules/telegram/gemini-threat-parser.service';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const service = app.get(GeminiThreatParserService);
    const result = await service.processPendingJobs();
    console.log(JSON.stringify(result, null, 2));
    // Allow Redis to flush pending operations before exit
    await new Promise(resolve => setTimeout(resolve, 500));
  } finally {
    await app.close();
  }
}

void main();
