import { Module } from '@nestjs/common';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { AlertsController } from './alerts.controller';
import { AlertsService } from './alerts.service';

@Module({
  imports: [SubscriptionsModule],
  controllers: [AlertsController],
  providers: [AlertsService],
})
export class AlertsModule {}
