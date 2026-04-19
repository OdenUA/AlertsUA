import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { SupabaseSyncService } from '../modules/supabase/supabase-sync.service';

function parseNumberArg(flag: string, fallback: number) {
  const raw = process.argv.find((value) => value.startsWith(`${flag}=`));
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw.slice(flag.length + 1));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const supabaseSyncService = app.get(SupabaseSyncService);
    const result = await supabaseSyncService.processOutbox({
      bootstrap: process.argv.includes('--bootstrap'),
      batchLimit: parseNumberArg('--limit', 250),
      maxBatches: parseNumberArg('--max-batches', 20),
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await app.close();
  }
}

void main();