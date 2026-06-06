import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { GeminiThreatParserService } from '../modules/telegram/gemini-threat-parser.service';

const WORKER_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes hard ceiling

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const service = app.get(GeminiThreatParserService);
    const result = await Promise.race([
      service.processPendingJobs(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Worker timed out after ${WORKER_TIMEOUT_MS}ms`)),
          WORKER_TIMEOUT_MS,
        ),
      ),
    ]);
    console.log(JSON.stringify(result, null, 2));
    // Allow Redis to flush pending operations before exit
    await new Promise(resolve => setTimeout(resolve, 500));
  } finally {
    await app.close();
  }
}

void main();
