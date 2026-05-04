#!/usr/bin/env node
/**
 * Worker to archive old threat overlays
 * Should run daily via systemd timer
 */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { MapService } from '../modules/map/map.service';
import { Logger } from '@nestjs/common';

async function run() {
  const logger = new Logger('ArchiveThreatsWorker');

  try {
    logger.log('Starting archive worker...');

    const app = await NestFactory.createApplicationContext(AppModule, {
      logger: ['error', 'warn', 'log'],
    });

    const mapService = app.get(MapService);

    // Archive old threats using the SQL function
    const result = await mapService.archiveOldThreats();

    logger.log(`Archive worker completed: ${result} overlays archived`);

    await app.close();
    process.exit(0);
  } catch (error) {
    logger.error('Archive worker failed:', error);
    process.exit(1);
  }
}

run();
