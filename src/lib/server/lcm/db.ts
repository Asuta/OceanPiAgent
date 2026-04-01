import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runLcmMigrations } from "./migration";

let databasePromise: Promise<DatabaseSync> | null = null;

function getDbRoot(): string {
  return path.join(process.cwd(), ".oceanking", "lcm");
}

function getDbPath(): string {
  return path.join(getDbRoot(), "lcm.sqlite");
}

export async function getLcmDatabase(): Promise<DatabaseSync> {
  if (!databasePromise) {
    databasePromise = (async () => {
      await mkdir(getDbRoot(), { recursive: true });
      const db = new DatabaseSync(getDbPath());
      runLcmMigrations(db);
      return db;
    })();
  }
  return databasePromise;
}

export async function closeLcmDatabase(): Promise<void> {
  const db = await databasePromise;
  databasePromise = null;
  db?.close();
}
