import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { GeometryImportService } from '../modules/map/geometry-import.service';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const geometryImportService = app.get(GeometryImportService);
    const result = await geometryImportService.importOchaBoundaries();
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await app.close();
  }
}

void main();