import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './common/database/database.module';
import { CacheModule } from './common/cache/cache.module';
import { AlertsModule } from './modules/alerts/alerts.module';
import { ImportsModule } from './modules/imports/imports.module';
import { InstallationsModule } from './modules/installations/installations.module';
import { MapModule } from './modules/map/map.module';
import { PushModule } from './modules/push/push.module';
import { SubscriptionsModule } from './modules/subscriptions/subscriptions.module';
import { SupabaseModule } from './modules/supabase/supabase.module';
import { SystemModule } from './modules/system/system.module';
import { TelegramModule } from './modules/telegram/telegram.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../secrets.env', '.env'], ignoreEnvFile: false }),
    CacheModule,
    DatabaseModule,
    SupabaseModule,
    SystemModule,
    InstallationsModule,
    MapModule,
    AlertsModule,
    SubscriptionsModule,
    PushModule,
    ImportsModule,
    TelegramModule,
  ],
})
export class AppModule {}
