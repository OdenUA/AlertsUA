import { Module } from '@nestjs/common';
import { GeometryImportService } from './geometry-import.service';
import { MapController } from './map.controller';
import { MapService } from './map.service';

@Module({
  controllers: [MapController],
  providers: [MapService, GeometryImportService],
  exports: [GeometryImportService],
})
export class MapModule {}
