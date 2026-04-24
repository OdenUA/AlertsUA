import { Controller, Get, Header, ParseIntPipe, Query } from '@nestjs/common';
import { MapService } from './map.service';
import { GEOMETRY_CHECK_PAGE_CSP, GEOMETRY_CHECK_PAGE_HTML } from './map.geometry-check.page';

@Controller('map')
export class MapController {
  constructor(private readonly mapService: MapService) {}

  @Get('geometry-check')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Content-Security-Policy', GEOMETRY_CHECK_PAGE_CSP)
  getGeometryCheckPage() {
    return GEOMETRY_CHECK_PAGE_HTML;
  }

  @Get('config')
  getConfig() {
    return this.mapService.getConfig();
  }

  @Get('regions')
  getRegions() {
    return this.mapService.getRegions();
  }

  @Get('ukraine-boundary')
  getUkraineBoundary() {
    return this.mapService.getUkraineBoundary();
  }

  @Get('feature')
  getFeature(@Query('uid', ParseIntPipe) uid: number) {
    return this.mapService.getFeatureByUid(uid);
  }

  @Get('features')
  getFeatures(
    @Query('layer') layer = 'oblast',
    @Query('bbox') bbox?: string,
    @Query('zoom') zoom?: string,
    @Query('pack_version') packVersion?: string,
  ) {
    return this.mapService.getFeatures(layer, bbox, zoom ? Number(zoom) : undefined, packVersion);
  }

  @Get('threat-overlays')
  getThreatOverlays(@Query('bbox') bbox?: string) {
    return this.mapService.getThreatOverlays(bbox);
  }

  @Get('active-alerts')
  getActiveAlerts() {
    return this.mapService.getActiveAlerts();
  }

  @Get('simplified-oblast')
  getSimplifiedOblastMap() {
    return this.mapService.getSimplifiedOblastMap();
  }
}
