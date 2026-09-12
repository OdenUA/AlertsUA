import { DatabaseService } from '../common/database/database.service';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';

async function rebuildAlertLayer() {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  const databaseService = app.get(DatabaseService);

  if (!databaseService.isConfigured()) {
    console.error('Database is not configured');
    process.exit(1);
  }

  console.log('Rebuilding alert_layer_features table...');

  await databaseService.withTransaction(async (client) => {
    // Clear existing alert layer
    await client.query('DELETE FROM alert_layer_features');
    console.log('✓ Cleared existing data');

    // Insert all regions with active alerts (excluding oblasts - their children are included).
    // Cities inherit active status from their parent oblast (e.g. м. Київ from Київська область).
    const result = await client.query(
      `
        INSERT INTO alert_layer_features (uid, region_type, alert_type, alert_level, geometry_json)
        SELECT rc.uid,
               rc.region_type,
               COALESCE(arc.alert_type, arc_parent.alert_type, 'air_raid') AS alert_type,
               COALESCE(arc.alert_level, arc_parent.alert_level, 'red') AS alert_level,
               ST_AsGeoJSON(
                 COALESCE(rgl.geom, ST_Simplify(rg.geom, 0.01))
               ) AS geometry_json
        FROM region_catalog rc
        JOIN region_geometry rg ON rg.uid = rc.uid
        LEFT JOIN region_geometry_lod rgl ON rgl.uid = rc.uid AND rgl.lod = 'low'
        LEFT JOIN air_raid_state_current arc ON arc.uid = rc.uid
        LEFT JOIN air_raid_state_current arc_parent
          ON arc_parent.uid = rc.oblast_uid AND arc_parent.status = 'A'
        WHERE (
            arc.status = 'A'
            OR (rc.region_type = 'city' AND arc_parent.uid IS NOT NULL)
          )
          AND (
            rc.region_type = 'city'
            OR
            rc.is_subscription_leaf = TRUE
          )
      `,
    );

    console.log(`✓ Inserted ${result.rowCount} features`);

    // Verify the data
    const countResult = await client.query('SELECT COUNT(*) as count FROM alert_layer_features');
    console.log(`✓ Total features in table: ${countResult.rows[0].count}`);

    // Show sample data
    const sampleResult = await client.query(
      'SELECT region_type, COUNT(*) as count FROM alert_layer_features GROUP BY region_type'
    );
    console.log('✓ Features by region_type:');
    sampleResult.rows.forEach((row: { region_type: string; count: string }) => {
      console.log(`  - ${row.region_type}: ${row.count}`);
    });

    console.log('Rebuild completed successfully!');
  });

  await app.close();
  process.exit(0);
}

rebuildAlertLayer().catch((error) => {
  console.error('Rebuild failed:', error);
  process.exit(1);
});
