import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Store } from "../server/store.mjs";
import { hashPassword, verifyPassword } from "../server/auth.mjs";
import { createApp } from "../server/server.mjs";
import { validateImport } from "../lib/import-state.mjs";

// Test credentials are deliberately unrelated to the deployed account passwords.
const accounts = [
  {
    login: "admin",
    name: "Admin",
    role: "admin",
    shop: null,
    password: "test-A",
  },
  ...[0, 1, 2].map((shop) => ({
    login: `Store ${shop + 1}`,
    name: `Store ${shop + 1}`,
    role: "manager",
    shop,
    password: "test-S",
  })),
];
const script = fileURLToPath(
  new URL("../scripts/provision-staff.mjs", import.meta.url),
);

test("offline provisioning supports usernames and scoped stores, is repeatable, and logs in through HTTP", async () => {
  const directory = mkdtempSync(join(tmpdir(), "alidjone-accounts-"));
  const database = join(directory, "test.sqlite");
  const provision = (records, allow = true) =>
    spawnSync(
      process.execPath,
      [script, ...(allow ? ["--allow-short-test-passwords"] : [])],
      {
        input: JSON.stringify(records),
        encoding: "utf8",
        env: { ...process.env, DATABASE_PATH: database },
      },
    );
  let app;
  try {
    assert.notEqual(
      provision(accounts, false).status,
      0,
      "short passwords require the explicit offline flag",
    );
    let result = provision(accounts);
    assert.equal(result.status, 0, result.stderr);
    result = provision(accounts);
    assert.equal(result.status, 0, result.stderr);
    const store = new Store(database);
    try {
      const state = store.read();
      assert.equal(state.staff.length, 4);
      assert.deepEqual(validateImport(state), state);
      for (const account of accounts) {
        const row = store.db
          .prepare("SELECT * FROM staff WHERE login=?")
          .get(account.login.toLowerCase());
        assert(row);
        assert(await verifyPassword(account.password, row.password_hash));
        assert(!row.payload.includes(account.password));
      }
    } finally {
      store.close();
    }
    app = await createApp({ database, origin: "http://127.0.0.1:5196" });
    await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    for (const account of accounts) {
      const response = await fetch(base + "/api/login", {
        method: "POST",
        headers: {
          Origin: "http://127.0.0.1:5196",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          login: account.login,
          password: account.password,
        }),
      });
      assert.equal(response.status, 200);
      const session = await response.json();
      assert.equal(session.user.role, account.role);
      assert.equal(session.user.shop, account.shop);
      const cookie = response.headers.get("set-cookie").split(";")[0];
      if (account.role === "manager") {
        assert.equal(
          (await fetch(base + "/api/finance", { headers: { Cookie: cookie } }))
            .status,
          200,
        );
        const wrongShop = await fetch(base + "/api/action", {
          method: "POST",
          headers: {
            Cookie: cookie,
            Origin: "http://127.0.0.1:5196",
            "Content-Type": "application/json",
            "X-CSRF-Token": session.csrf,
            "Idempotency-Key": crypto.randomUUID(),
          },
          body: JSON.stringify({
            action: "create",
            type: "sale",
            shop: (account.shop + 1) % 3,
          }),
        });
        assert.equal(wrongShop.status, 403);
      }
    }
  } finally {
    if (app) {
      await new Promise((resolve) => app.server.close(resolve));
      app.store.close();
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("normal account APIs retain the minimum password length", async () => {
  await assert.rejects(hashPassword("short"), /12/);
  const encoded = await hashPassword("short", { allowShortForTesting: true });
  assert(await verifyPassword("short", encoded));
  await assert.rejects(hashPassword("", { allowShortForTesting: true }));
});
