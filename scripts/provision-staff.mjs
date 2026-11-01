// Offline account provisioning. Read credentials only from JSON on stdin.
import { Store } from "../server/store.mjs";
import { hashPassword } from "../server/auth.mjs";
import { staffChange, validLogin } from "../lib/warehouse.mjs";

if (!process.env.DATABASE_PATH) throw Error("Set DATABASE_PATH");
const allowShortForTesting = process.argv.includes(
  "--allow-short-test-passwords",
);
let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 64 * 1024) throw Error("Too many account records");
}
const records = JSON.parse(input);
if (!Array.isArray(records) || !records.length || records.length > 100)
  throw Error("Expected 1–100 accounts as a JSON array");
const prepared = [],
  logins = new Set();
for (const record of records) {
  if (!record || !validLogin(record.login))
    throw Error("Invalid account login");
  const login = record.login.trim().toLowerCase();
  if (logins.has(login)) throw Error("Duplicate account login");
  logins.add(login);
  prepared.push({
    ...record,
    login,
    hash: await hashPassword(record.password, { allowShortForTesting }),
  });
}
const store = new Store(process.env.DATABASE_PATH);
try {
  store.transaction(() => {
    const before = store.read(),
      state = structuredClone(before);
    const operator = {
      id: "offline-provisioning",
      name: "Account provisioning",
      role: "admin",
    };
    const changed = new Set();
    for (const record of prepared) {
      const existing =
        state.staff.find((user) => user.login === record.login) ||
        (record.replaceLogin &&
          state.staff.find(
            (user) => user.login === record.replaceLogin.trim().toLowerCase(),
          ));
      if (existing && changed.has(existing.id))
        throw Error("Account targeted more than once");
      const id = staffChange(
        state,
        {
          id: existing?.id,
          login: record.login,
          name: record.name,
          role: record.role,
          shop: record.shop,
          active: true,
        },
        operator,
      );
      changed.add(id);
      record.id = id;
    }
    if (!state.staff.some((user) => user.role === "admin" && user.active))
      throw Error("An active administrator is required");
    store.save(before, state);
    for (const record of prepared) {
      store.db
        .prepare("UPDATE staff SET password_hash=? WHERE id=?")
        .run(record.hash, record.id);
      store.db.prepare("DELETE FROM sessions WHERE user_id=?").run(record.id);
    }
  });
  console.log(
    `Provisioned ${prepared.length} accounts; their previous sessions were revoked.`,
  );
} finally {
  store.close();
}
