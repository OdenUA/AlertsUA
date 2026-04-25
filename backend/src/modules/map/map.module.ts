import { Module } from '@nestjs/common';
import { CacheModule } from '../../common/cache/cache.module';
import { GeometryImportService } from './geometry-import.service';
import { MapController } from './map.controller';
import { MapService } from './map.service';
import { MapBundleService } from './map-bundle.service';

@Module({
  imports: [CacheModule],
  controllers: [MapController],
  providers: [MapService, GeometryImportService, MapBundleService],
  exports: [GeometryImportService],
})
export class MapModule {}
