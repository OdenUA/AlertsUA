import { DatabaseService } from '../common/database/database.service';
import { DatabaseModule } from '../common/database/database.module';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';

async function applyMigration() {
  const app = await NestFactory.create(AppModule);
  const databaseService = app.get(DatabaseService);

  if (!databaseService.isConfigured()) {
    console.error('Database is not configured');
    process.exit(1);
  }

  console.log('Applying alert_layer_features migration...');

  await databaseService.query(`
    CREATE TABLE IF NOT EXISTS alert_layer_features (
      feature_id SERIAL PRIMARY KEY,
      uid INTEGER NOT NULL REFERENCES region_catalog(uid) ON DELETE CASCADE,
      region_type TEXT NOT NULL CHECK (region_type IN ('oblast', 'city', 'raion', 'hromada')),
      alert_type TEXT NOT NULL DEFAULT 'air_raid',
      geometry_json TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  console.log('✓ Table created');

  await databaseService.query(`
    CREATE INDEX IF NOT EXISTS idx_alert_layer_features_uid ON alert_layer_features(uid)
  `);
  console.log('✓ Index on uid created');

  await databaseService.query(`
    CREATE INDEX IF NOT EXISTS idx_alert_layer_features_type ON alert_layer_features(region_type)
  `);
  console.log('✓ Index on region_type created');

  await databaseService.query(`
    CREATE OR REPLACE FUNCTION update_alert_layer_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  console.log('✓ Function created');

  await databaseService.query(`
    DROP TRIGGER IF EXISTS trigger_alert_layer_features_updated_at ON alert_layer_features
  `);
  console.log('✓ Old trigger dropped');

  await databaseService.query(`
    CREATE TRIGGER trigger_alert_layer_features_updated_at
      BEFORE UPDATE ON alert_layer_features
      FOR EACH ROW
      EXECUTE FUNCTION update_alert_layer_updated_at()
  `);
  console.log('✓ Trigger created');

  console.log('Migration completed successfully!');
  await app.close();
  process.exit(0);
}

applyMigration().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});
