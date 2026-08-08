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
  const seen = new Map<number, string>();
  const migrations = readdirSync(MIGRATIONS_DIR)
    .filter((name) => MIGRATION_FILE_PATTERN.test(name))
    .sort()
    .map((file) => {
      const version = Number.parseInt(MIGRATION_FILE_PATTERN.exec(file)?.[1] ?? "", 10);
      // Two files sharing a number would leave the second one permanently unapplied, because
      // user_version can only record one of them. That is a merge accident, not a schema.
      const clash = seen.get(version);
      if (clash !== undefined) {
        throw new Error(`Migrations ${clash} and ${file} share version ${version}.`);
      }
      seen.set(version, file);
      return { file, version };
    });

  for (const { file, version } of migrations) {
    if (version <= current) continue;
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
