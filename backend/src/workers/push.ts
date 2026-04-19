import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { PushService } from '../modules/push/push.service';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const pushService = app.get(PushService);
    const result = await pushService.processQueuedDispatches();
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await app.close();
  }
}

void main();
