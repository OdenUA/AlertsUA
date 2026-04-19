import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { AlertsService } from '../modules/alerts/alerts.service';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const alertsService = app.get(AlertsService);
    const result = await alertsService.runPollCycle();
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await app.close();
  }
}

void main();
