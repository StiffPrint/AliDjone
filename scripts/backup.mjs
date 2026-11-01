import { DatabaseSync, backup } from "node:sqlite";
import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
const path = process.env.DATABASE_PATH || "data/warehouse.sqlite";
const directory = process.env.BACKUP_DIR || "data/backups";
mkdirSync(directory, { recursive: true, mode: 0o700 });
const source = new DatabaseSync(path, { readOnly: true });
const target = join(
  directory,
  `warehouse-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`,
);
await backup(source, target);
source.close();
const check = new DatabaseSync(target);
// Keep each backup self-contained, without WAL/SHM sidecars.
check.exec("PRAGMA journal_mode=DELETE");
if (check.prepare("PRAGMA integrity_check").get().integrity_check !== "ok")
  throw Error("Backup integrity check failed");
check.close();
const files = readdirSync(directory)
  .filter((file) => /^warehouse-.*\.sqlite$/.test(file))
  .sort();
for (const file of files.slice(0, -14)) unlinkSync(join(directory, file));
console.log(`Backup verified: ${target}`);
