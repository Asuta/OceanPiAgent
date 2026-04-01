import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getLcmDbFeatures } from "./features";
import { runLcmMigrations } from "./migration";

let databasePromise: Promise<DatabaseSync> | null = null;
let databasePath: string | null = null;

function getDbRoot(): string {
  return path.join(process.cwd(), ".oceanking", "lcm");
}

function getDbPath(): string {
  return path.join(getDbRoot(), "lcm.sqlite");
}

export async function getLcmDatabase(): Promise<DatabaseSync> {
  const nextPath = getDbPath();
  if (databasePromise && databasePath && databasePath !== nextPath) {
    const existing = await databasePromise;
    existing.close();
    databasePromise = null;
    databasePath = null;
  }

  if (!databasePromise) {
    databasePromise = (async () => {
      await mkdir(getDbRoot(), { recursive: true });
      const db = new DatabaseSync(nextPath);
      runLcmMigrations(db, getLcmDbFeatures(db));
      return db;
    })();
    databasePath = nextPath;
  }
  return databasePromise;
}

export async function closeLcmDatabase(): Promise<void> {
  const db = await databasePromise;
  databasePromise = null;
  databasePath = null;
  db?.close();
}
