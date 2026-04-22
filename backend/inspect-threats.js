const fs = require('fs');
const { Client } = require('pg');
const env = fs.readFileSync('../secrets.env', 'utf8').split(/\r?\n/).reduce((acc, line) => {
  const m = line.match(/^([^#=]+)=(.*)$/);
  if (m) acc[m[1]] = m[2];
  return acc;
}, {});

(async () => {
  const client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  const q = `select count(*) as cnt from threat_visual_overlays tvo join threat_vectors tv on tv.vector_id = tvo.vector_id where tvo.status='active' and tv.occurred_at + interval '2 day' > now() limit 10`;
  const res = await client.query(q);
  console.log('count', res.rows);
  const q2 = `select tv.threat_kind, tv.icon_type, tv.movement_bearing_deg, ST_AsGeoJSON(COALESCE(tv.origin_geom, tv.target_geom)) as marker_json, ST_AsGeoJSON(tv.corridor_geom) as corridor_json, ST_AsGeoJSON(tv.danger_area_geom) as area_json from threat_visual_overlays tvo join threat_vectors tv on tv.vector_id=tvo.vector_id where tvo.status='active' order by tv.occurred_at desc limit 5`;
  const res2 = await client.query(q2);
  console.log(JSON.stringify(res2.rows, null, 2));
  await client.end();
})();
