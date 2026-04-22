SELECT arc.uid, rc.title_uk, arc.status, arc.alert_type, (rg.uid IS NOT NULL) AS has_geom 
FROM air_raid_state_current arc 
JOIN region_catalog rc ON arc.uid = rc.uid 
LEFT JOIN region_geometry rg ON rg.uid = rc.uid 
WHERE arc.status = 'A';
