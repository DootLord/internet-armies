BEGIN;

INSERT INTO sectors (name, terrain_seed, terrain_version, radius_px)
VALUES ('Kestrel Cluster', 20261029, 1, 14000)
ON CONFLICT (name) DO NOTHING;

INSERT INTO starter_templates (name, credits, alloy, energy, crystal)
VALUES ('default', 900, 450, 60, 40)
ON CONFLICT (name) DO NOTHING;

COMMIT;
