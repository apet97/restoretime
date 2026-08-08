// SQLite open + migrate (docs/08). WAL mode, foreign_keys=ON, user_version tracks the applied
// migration. No ORM (implementation/DEPENDENCIES.md): prepared statements only.

import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations", import.meta.url));
const MIGRATION_FILE_PATTERN = /^(\d{4})_.+\.sql$/;

function migrate(db: Database.Database): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => MIGRATION_FILE_PATTERN.test(name))
    .sort();

  for (const file of files) {
    const match = MIGRATION_FILE_PATTERN.exec(file);
    const version = Number.parseInt(match?.[1] ?? "", 10);
    if (!Number.isInteger(version) || version <= current) continue;

    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${version}`);
    })();
  }
}

/** Opens (creating if absent) and migrates the RestoreTime database. Idempotent: a second call
 * on the same file re-applies no migration and leaves existing rows untouched. */
export function openDatabase(databasePath: string): Database.Database {
  const db = new Database(databasePath);
  // WAL is a no-op on ":memory:" databases (SQLite has no WAL journal there); harmless to set
  // unconditionally rather than special-casing the path.
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}
