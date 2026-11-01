import { readFileSync } from "node:fs";
import { Store } from "../server/store.mjs";
import { validateImport } from "../lib/import-state.mjs";

const [source, target] = process.argv.slice(2);
if (!source || !target)
  throw Error("Usage: node scripts/import-state.mjs state.json target.sqlite");
const state = validateImport(JSON.parse(readFileSync(source, "utf8")));
const store = new Store(target);
try {
  store.transaction(() => {
    const before = store.read();
    if (
      ["staff", "products", "units", "documents", "audit", "lots", "cash"].some(
        (table) => before[table].length,
      ) ||
      Object.keys(before.balances).length ||
      store.db.prepare("SELECT 1 FROM sessions LIMIT 1").get() ||
      store.db.prepare("SELECT 1 FROM operations LIMIT 1").get()
    )
      throw Error("Target database must be empty");
    store.save(before, state);
  });
  console.log(
    "Imported entities into SQLite. Set account passwords with scripts/set-password.mjs.",
  );
} finally {
  store.close();
}
