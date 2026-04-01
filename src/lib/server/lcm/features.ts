import type { DatabaseSync } from "node:sqlite";

export type LcmDbFeatures = {
  fts5Available: boolean;
};

const featureCache = new WeakMap<DatabaseSync, LcmDbFeatures>();

function probeFts5(db: DatabaseSync): boolean {
  try {
    db.exec("DROP TABLE IF EXISTS temp.__lcm_fts5_probe");
    db.exec("CREATE VIRTUAL TABLE temp.__lcm_fts5_probe USING fts5(content)");
    db.exec("DROP TABLE temp.__lcm_fts5_probe");
    return true;
  } catch {
    try {
      db.exec("DROP TABLE IF EXISTS temp.__lcm_fts5_probe");
    } catch {}
    return false;
  }
}

export function getLcmDbFeatures(db: DatabaseSync): LcmDbFeatures {
  const cached = featureCache.get(db);
  if (cached) {
    return cached;
  }

  const detected: LcmDbFeatures = {
    fts5Available: probeFts5(db),
  };
  featureCache.set(db, detected);
  return detected;
}
