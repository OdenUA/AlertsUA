SELECT rc.uid, rc.title_uk, COUNT(leaf.uid) AS total_leaves, COUNT(*) FILTER (WHERE leaf_state.status = 'A') AS active_leaves 
FROM region_catalog rc 
JOIN region_catalog leaf ON leaf.is_active = TRUE AND leaf.is_subscription_leaf = TRUE AND leaf.oblast_uid = rc.uid 
LEFT JOIN air_raid_state_current leaf_state ON leaf_state.uid = leaf.uid 
WHERE rc.title_uk ILIKE '%Харківськ%' AND rc.region_type = 'oblast' 
GROUP BY rc.uid, rc.title_uk;
