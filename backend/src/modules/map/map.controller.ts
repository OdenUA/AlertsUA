import { Controller, Get, Header, ParseIntPipe, Post, Query } from '@nestjs/common';
import { MapService } from './map.service';
import { OccupiedTerritoriesService } from './occupied-territories.service';
import { OccupiedTerritoriesGeoJSON } from './occupied-territories.service';
import { GEOMETRY_CHECK_PAGE_CSP, GEOMETRY_CHECK_PAGE_HTML } from './map.geometry-check.page';

@Controller('map')
export class MapController {
  constructor(
    private readonly mapService: MapService,
    private readonly occupiedTerritoriesService: OccupiedTerritoriesService,
  ) {}

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

  @Get('active-alerts-simplified')
  getActiveAlertsSimplified() {
    return this.mapService.getActiveAlertsSimplified();
  }

  @Get('alerts-layer')
  getAlertsLayer() {
    return this.mapService.getAlertsLayer();
  }

  @Get('simplified-oblast')
  getSimplifiedOblastMap() {
    return this.mapService.getSimplifiedOblastMap();
  }

  @Get('occupied-territories')
  getOccupiedTerrories() {
    return this.occupiedTerritoriesService.getOccupiedTerrories();
  }

  @Get('occupied-territories-layer')
  getOccupiedTerroriesLayer() {
    return this.occupiedTerritoriesService.getOccupiedTerroriesLayer();
  }

  @Get('bundle')
  getMapBundle() {
    return this.mapService.getFullMapBundle();
  }

  @Get('threat-bundle')
  getThreatBundle() {
    return this.mapService.getThreatBundle();
  }

  @Post('bundle/rebuild')
  async rebuildMapBundle() {
    return this.mapService.rebuildFullMapBundle();
  }

  @Post('threat-bundle/rebuild')
  async rebuildThreatBundle() {
    return this.mapService.rebuildThreatBundle();
  }

  @Get('static-geometry')
  getStaticGeometry(
    @Query('layer') layer = 'oblast',
    @Query('simplify') simplify = '0.01',
  ) {
    return this.mapService.getStaticGeometry(layer, parseFloat(simplify));
  }
}
