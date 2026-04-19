import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { ImportsService } from '../modules/imports/imports.service';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const importsService = app.get(ImportsService);
    const result = await importsService.importWorkbook(
      process.argv[2] ?? '/srv/alerts-ua/data/imports/source/alerts-regions.xlsx',
    );
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await app.close();
  }
}

void main();
