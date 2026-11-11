import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { PushService } from '../modules/push/push.service';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  let stopping = false;
  const stop = () => {
    stopping = true;
  };

  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  try {
    const pushService = app.get(PushService);
    await pushService.run(() => stopping);
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    await app.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
