import { Controller, Get } from '@nestjs/common';
import { DatabaseService } from '../../common/database/database.service';
import { TimeUtil } from '../../common/utils/time.util';

@Controller('system')
export class SystemController {
  constructor(private readonly databaseService: DatabaseService) {}

  @Get('health')
  async getHealth() {
    const database = await this.databaseService.checkHealth();

    return {
      status: 'ok',
      service: 'alerts-ua-backend',
      version: '0.1.0',
      timestamp: TimeUtil.getNowInKyiv(),
      database,
    };
  }
}
