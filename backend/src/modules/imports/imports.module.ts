import { Module } from '@nestjs/common';
import { ImportsService } from './imports.service';

@Module({
  providers: [ImportsService],
  exports: [ImportsService],
})
export class ImportsModule {}
