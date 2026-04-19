import { Controller, Get, Query } from '@nestjs/common';
import { AlertsService } from './alerts.service';

@Controller('alerts/statuses')
export class AlertsController {
  constructor(private readonly alertsService: AlertsService) {}

  @Get('full')
  async getFull() {
    return this.alertsService.getFullStatuses();
  }

  @Get('delta')
  async getDelta(@Query('since_version') sinceVersion = '0') {
    return this.alertsService.getDeltaStatuses(Number(sinceVersion));
  }
}
