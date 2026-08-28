import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { GeminiThreatParserService } from '../modules/telegram/gemini-threat-parser.service';

const WORKER_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes hard ceiling
const APP_CLOSE_GRACE_MS = 2_000;

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  let timeoutId: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`Worker timed out after ${WORKER_TIMEOUT_MS}ms`)),
      WORKER_TIMEOUT_MS,
    );
  });

  try {
    const service = app.get(GeminiThreatParserService);
    const result = await Promise.race([
      service.processPendingJobs(),
      timeoutPromise,
    ]);
    console.log(JSON.stringify(result, null, 2));
    // Allow Redis to flush pending operations before exit
    await new Promise((resolve) => setTimeout(resolve, 500));
  } finally {
    // Cancel the hard-ceiling timeout so it does not become an unhandled
    // rejection and keep the process alive via undici keep-alive connections.
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    // Give NestJS a short grace period to close DB/Redis connections, then
    // terminate the process explicitly. Global fetch keep-alive sockets can
    // otherwise prevent Node from exiting.
    try {
      await Promise.race([
        app.close(),
        new Promise((resolve) => setTimeout(resolve, APP_CLOSE_GRACE_MS)),
      ]);
    } catch (closeError) {
      console.error('Error during app.close():', closeError);
    }
    process.exit(0);
  }
}

void main();
