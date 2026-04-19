import { Module } from '@nestjs/common';
import { InstallationsController } from './installations.controller';
import { InstallationsService } from './installations.service';

@Module({
  controllers: [InstallationsController],
  providers: [InstallationsService],
  exports: [InstallationsService],
})
export class InstallationsModule {}
