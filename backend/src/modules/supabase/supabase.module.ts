import { Global, Module } from '@nestjs/common';
import { SupabaseSyncService } from './supabase-sync.service';

@Global()
@Module({
  providers: [SupabaseSyncService],
  exports: [SupabaseSyncService],
})
export class SupabaseModule {}