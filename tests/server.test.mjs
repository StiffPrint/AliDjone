import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../server/server.mjs";
import { Store } from "../server/store.mjs";
import { fresh, apply, view } from "../lib/warehouse.mjs";
import { finance } from "../lib/finance.mjs";

const password = "Test-only-Password-934!";
const admin = {
  id: "a",
  login: "admin@example.com",
  name: "Admin",
  role: "admin",
  active: 1,
  shop: null,
};
function fixture() {
  let state = fresh();
  state.staff = [admin];
  const run = (body, user = admin) => {
    const next = structuredClone(state);
    const result = apply(next, body, user);
    state = next;
    return result;
  };
  const product = (kind = "phone", buy = 10000) =>
    run({
      action: "product",
      product: { name: kind, barcode: randomUUID(), kind, buy, sell: 20000 },
    });
  const receipt = (
    product,
    shop,
    serials = [],
    quantity = 1,
    buy = undefined,
  ) => {
    const id = run({ action: "create", type: "receipt", shop });
    run({
      action: "line",
      id,
      product,
      quantity,
      ...(buy === undefined ? {} : { buy }),
    });
    const line = state.documents.at(-1).lines[0].id;
    for (const serial of serials) run({ action: "scan", id, line, serial });
    run({ action: "post", id });
    return id;
  };
  return {
    get state() {
      return state;
    },
    run,
    product,
    receipt,
  };
}

test("manager isolation covers documents, serials, balances, audit snapshots and catalogue", () => {
  const x = fixture(),
    product = x.product();
  x.receipt(product, 0, ["OWN"]);
  x.receipt(product, 1, ["FOREIGN"]);
  const manager = { id: "m", name: "M", role: "manager", shop: 0 };
  const result = view(x.state, manager);
  assert(result.documents.every((d) => d.shop === 0));
  assert(result.units.every((item) => item.serial === "OWN"));
  assert.deepEqual(result.products[0].quantities, [1, 0, 0]);
  assert.deepEqual(result.balances[product], [0, 0, 0]);
  assert(result.audit.every((event) => event.shop === 0));
  const json = JSON.stringify(result);
  for (const key of [
    '"buy"',
    '"cost"',
    '"costs"',
    '"changes"',
    '"staff"',
    '"lots"',
    "FOREIGN",
  ])
    assert(!json.includes(key), key);
  assert.throws(() =>
    x.run(
      {
        action: "product",
        product: {
          id: product,
          name: "Changed",
          barcode: "1",
          kind: "phone",
          sell: 1,
        },
      },
      manager,
    ),
  );
  assert.throws(() =>
    x.run({
      action: "product",
      product: {
        name: "Duplicate",
        barcode: x.state.products[0].barcode.toUpperCase(),
        kind: "phone",
        sell: 1,
      },
    }),
  );
  assert.throws(() => finance(x.state, manager));
  const draft = x.run({ action: "create", type: "sale", shop: 0 }, manager);
  x.run({ action: "line", id: draft, product }, manager);
  const line = x.state.documents.at(-1).lines[0].id;
  assert.throws(() =>
    x.run(
      {
        action: "update_line",
        id: draft,
        line,
        serial_ids: [
          x.state.units.find((item) => item.serial === "FOREIGN").id,
        ],
      },
      manager,
    ),
  );
});

test("sales and writeoffs by typed serial at all three shops; duplicate and wrong-shop rejected", () => {
  const x = fixture(),
    product = x.product();
  for (const shop of [0, 1, 2]) {
    x.receipt(product, shop, [`SALE-${shop}`, `LOSS-${shop}`]);
    const manager = { id: `m${shop}`, name: `M${shop}`, role: "manager", shop };
    for (const type of ["sale", "writeoff"]) {
      const id = x.run(
        { action: "create", type, shop, reason: "Повреждение" },
        manager,
      );
      const serial = `${type === "sale" ? "SALE" : "LOSS"}-${shop}`;
      assert.throws(() =>
        x.run({ action: "serial_add", id, serial: "DOES-NOT-EXIST" }, manager),
      );
      x.run(
        { action: "serial_add", id, serial: ` ${serial.toLowerCase()} ` },
        manager,
      );
      assert.throws(() => x.run({ action: "serial_add", id, serial }, manager));
      x.run({ action: "post", id }, manager);
      x.run({ action: "post", id }, manager);
      assert.equal(
        x.state.units.find((item) => item.serial === serial).status,
        type === "sale" ? "sold" : "written_off",
      );
      assert(
        x.state.audit.some(
          (event) => event.actor_id === manager.id && event.changes?.length,
        ),
      );
    }
  }
  x.receipt(product, 1, ["SHOP-ONE"]);
  const sale = x.run({ action: "create", type: "sale", shop: 0 });
  assert.throws(() =>
    x.run({ action: "serial_add", id: sale, serial: "SHOP-ONE" }),
  );
  assert.throws(() =>
    x.run({ action: "serial_add", id: sale, serial: "SALE-0" }),
  );
  const report = finance(x.state, admin);
  for (const shop of report.shops) {
    assert.equal(shop.revenue, 20000);
    assert.equal(shop.knownCost, 10000);
    assert.equal(shop.writeoffCost, 10000);
    assert.equal(shop.profit, 0);
  }
});

test("FIFO cost, cash/card, partial return and transfer preserve actual purchase cost", () => {
  const x = fixture(),
    product = x.product("other", 100);
  x.receipt(product, 0, [], 2, 100);
  x.receipt(product, 0, [], 3, 200);
  const id = x.run({
    action: "create",
    type: "sale",
    shop: 0,
    payment: "card",
  });
  x.run({ action: "line", id, product, quantity: 3, sell: 500 });
  const line = x.state.documents.at(-1).lines[0].id;
  x.run({ action: "post", id });
  assert.equal(x.state.documents.at(-1).lines[0].cost, 400);
  let report = finance(x.state, admin).shops[0];
  assert.equal(report.revenue, 1500);
  assert.equal(report.profit, 1100);
  assert.equal(report.cash, 0);
  for (const quantity of [1, 2]) {
    const ret = x.run({
      action: "create",
      type: "customer_return",
      shop: 0,
      sale: id,
    });
    x.run({ action: "line", id: ret, product, quantity, sale_line: line });
    x.run({ action: "post", id: ret });
  }
  report = finance(x.state, admin).shops[0];
  assert.equal(report.netRevenue, 0);
  assert.equal(report.knownCost, 0);
  assert.equal(report.profit, 0);
  assert.equal(report.cash, 0);
  assert.throws(() =>
    x.run({ action: "create", type: "customer_return", shop: 1, sale: id }),
  );
  const transfer = x.run({
    action: "create",
    type: "transfer",
    shop: 0,
    to: 1,
  });
  x.run({ action: "line", id: transfer, product, quantity: 3 });
  const transferLine = x.state.documents.at(-1).lines[0].id;
  x.run({ action: "post", id: transfer });
  x.run({
    action: "accept",
    id: transfer,
    lines: [{ line: transferLine, accepted: 1 }],
  });
  x.run({
    action: "accept",
    id: transfer,
    lines: [{ line: transferLine, accepted: 3 }],
  });
  assert.equal(
    x.state.lots
      .filter((l) => l.shop === 1)
      .reduce((sum, lot) => sum + lot.quantity * lot.buy, 0),
    500,
  );
});

test("unknown unit cost does not create fictitious profit; known serial cost overrides catalogue", () => {
  const x = fixture(),
    product = x.product("phone", null);
  x.receipt(product, 0, ["UNKNOWN"]);
  let id = x.run({ action: "create", type: "sale", shop: 0 });
  x.run({ action: "serial_add", id, serial: "UNKNOWN" });
  x.run({ action: "post", id });
  assert.equal(finance(x.state, admin).shops[0].profit, null);
  x.receipt(product, 1, ["KNOWN"], 1, 4321);
  id = x.run({ action: "create", type: "sale", shop: 1 });
  x.run({ action: "serial_add", id, serial: "KNOWN" });
  x.run({ action: "post", id });
  assert.equal(finance(x.state, admin).shops[1].knownCost, 4321);
});

test("mixed known and unknown costs are reversed exactly by separate serial returns", () => {
  const x = fixture(),
    product = x.product("phone", null);
  x.receipt(product, 0, ["MIX-UNKNOWN"]);
  x.receipt(product, 0, ["MIX-KNOWN"], 1, 500);
  const sale = x.run({ action: "create", type: "sale", shop: 0 });
  x.run({ action: "serial_add", id: sale, serial: "MIX-UNKNOWN" });
  x.run({ action: "serial_add", id: sale, serial: "MIX-KNOWN" });
  const original = x.state.documents.at(-1).lines[0].id;
  x.run({ action: "post", id: sale });
  let report = finance(x.state, admin).shops[0];
  assert.equal(report.knownCost, 500);
  assert.equal(report.unknownCostUnits, 1);
  assert.equal(report.profit, null);
  for (const serial of ["MIX-KNOWN", "MIX-UNKNOWN"]) {
    const id = x.run({
      action: "create",
      type: "customer_return",
      shop: 0,
      sale,
    });
    x.run({ action: "line", id, product, sale_line: original });
    const line = x.state.documents.at(-1).lines[0].id;
    x.run({
      action: "update_line",
      id,
      line,
      serial_ids: [x.state.units.find((unit) => unit.serial === serial).id],
    });
    x.run({ action: "post", id });
  }
  report = finance(x.state, admin).shops[0];
  assert.equal(report.knownCost, 0);
  assert.equal(report.unknownCostUnits, 0);
  assert.equal(report.profit, 0);
  assert.equal(report.cash, 0);
});

test("SQLite stores more than 2MB and rolls back invalid multi-line posting, persists after reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "alidjone-sqlite-")),
    path = join(directory, "warehouse.sqlite");
  try {
    let store = new Store(path);
    const before = store.read(),
      state = structuredClone(before);
    for (let i = 0; i < 1100; i++)
      state.documents.push({
        id: `doc-${i}`,
        number: i,
        type: "writeoff",
        status: "draft",
        shop: 0,
        to: null,
        reason: "А".repeat(1000),
        lines: [],
      });
    assert(Buffer.byteLength(JSON.stringify(state)) > 2_000_000);
    store.transaction(() => store.save(before, state));
    store.close();
    store = new Store(path);
    assert.equal(store.read().documents.length, 1100);
    assert.throws(() =>
      store.transaction(() => {
        store.db.prepare("DELETE FROM documents").run();
        throw Error("abort");
      }),
    );
    assert.equal(store.read().documents.length, 1100);
    assert.equal(
      store.db.prepare("PRAGMA integrity_check").get().integrity_check,
      "ok",
    );
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("HTTP auth, CSRF, idempotency, serial sales, concurrent posts, finance, expenses and revoked accounts", async () => {
  const origin = "http://127.0.0.1:5199";
  const { server, store } = await createApp({
    database: ":memory:",
    origin,
    adminLogin: admin.login,
    adminPassword: password,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => ({ cookie: "", csrf: "" });
  const owner = client(),
    manager = client();
  async function call(user, path, body, extra = {}) {
    const response = await fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: {
        Cookie: user.cookie,
        Origin: origin,
        "Content-Type": "application/json",
        "X-CSRF-Token": user.csrf,
        "Idempotency-Key": randomUUID(),
        ...extra,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json();
    if (response.headers.get("set-cookie"))
      user.cookie = response.headers.get("set-cookie").split(";")[0];
    if (data.csrf) user.csrf = data.csrf;
    return { status: response.status, data };
  }
  const action = async (body) => {
    const r = await call(owner, "/api/action", body);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data;
  };
  try {
    assert.equal((await call(owner, "/api/state")).status, 401);
    assert.equal(
      (
        await call(owner, "/api/login", {
          login: admin.login,
          password: "wrong",
        })
      ).status,
      401,
    );
    assert.equal(
      (await call(owner, "/api/login", { login: admin.login, password }))
        .status,
      200,
    );
    assert.equal(
      (
        await call(
          owner,
          "/api/action",
          { action: "create", type: "sale", shop: 0 },
          { Origin: "https://evil.example" },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          owner,
          "/api/action",
          { action: "create", type: "sale", shop: 0 },
          { "X-CSRF-Token": "wrong" },
        )
      ).status,
      403,
    );
    const key = randomUUID(),
      create = { action: "create", type: "receipt", shop: 0 };
    const first = await call(owner, "/api/action", create, {
      "Idempotency-Key": key,
    });
    const second = await call(owner, "/api/action", create, {
      "Idempotency-Key": key,
    });
    assert.equal(first.data.result, second.data.result);
    assert.equal(second.data.state.documents.length, 1);
    assert.equal(
      (
        await call(
          owner,
          "/api/action",
          { ...create, shop: 1 },
          { "Idempotency-Key": key },
        )
      ).status,
      409,
    );
    const product = (
      await action({
        action: "product",
        product: {
          name: "Phone",
          barcode: "001",
          kind: "phone",
          buy: 10000,
          sell: 20000,
        },
      })
    ).result;
    const id = first.data.result;
    await action({ action: "line", id, product });
    const line = store.read().documents.find((d) => d.id === id).lines[0].id;
    await action({ action: "scan", id, line, serial: "HTTP-SERIAL" });
    await action({ action: "post", id });
    const accessory = (
      await action({
        action: "product",
        product: {
          name: "Case",
          barcode: "HTTP-CASE",
          kind: "other",
          buy: 100,
          sell: 200,
        },
      })
    ).result;
    const brokenSale = (
      await action({ action: "create", type: "sale", shop: 0 })
    ).result;
    await action({
      action: "serial_add",
      id: brokenSale,
      serial: "HTTP-SERIAL",
    });
    await action({
      action: "line",
      id: brokenSale,
      product: accessory,
      quantity: 1,
    });
    const snapshot = JSON.stringify(store.read());
    assert.equal(
      (await call(owner, "/api/action", { action: "post", id: brokenSale }))
        .status,
      400,
    );
    assert.equal(
      JSON.stringify(store.read()),
      snapshot,
      "Failed multi-line sale persisted part of the stock mutation",
    );
    await action({ action: "cancel", id: brokenSale });
    const account = {
      login: "manager@example.com",
      name: "Manager",
      role: "manager",
      shop: 0,
      password,
    };
    let r = await call(owner, "/api/users", account);
    assert.equal(r.status, 200);
    const managerId = r.data.result;
    assert.equal(
      (await call(manager, "/api/login", { login: account.login, password }))
        .status,
      200,
    );
    assert.equal((await call(manager, "/api/finance")).status, 403);
    assert.equal((await call(manager, "/api/users")).status, 403);
    const sale = (
      await call(manager, "/api/action", {
        action: "create",
        type: "sale",
        shop: 0,
      })
    ).data.result;
    assert.equal(
      (
        await call(manager, "/api/action", {
          action: "serial_add",
          id: sale,
          serial: "HTTP-SERIAL",
        })
      ).status,
      200,
    );
    const results = await Promise.all([
      call(manager, "/api/action", { action: "post", id: sale }),
      call(manager, "/api/action", { action: "post", id: sale }),
    ]);
    assert(results.every((result) => result.status === 200));
    r = await call(owner, "/api/finance");
    assert.equal(r.data.shops[0].profit, 10000);
    assert.equal(r.data.shops[0].cash, 20000);
    assert.equal(
      (
        await call(owner, "/api/cash", {
          shop: 0,
          type: "expense",
          amount: 2000,
          reason: "Rent",
        })
      ).status,
      200,
    );
    r = await call(owner, "/api/finance");
    assert.equal(r.data.shops[0].profit, 8000);
    assert.equal(r.data.shops[0].cash, 18000);
    assert.equal(
      (
        await call(manager, "/api/cash", {
          shop: 0,
          type: "deposit",
          amount: 1,
          reason: "No",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await call(owner, "/api/users", {
          ...account,
          id: managerId,
          password: undefined,
          active: false,
        })
      ).status,
      200,
    );
    assert.equal((await call(manager, "/api/state")).status, 401);
    assert.equal(
      (
        await call(owner, "/api/password", {
          current: password,
          password: password + "-new",
        })
      ).status,
      200,
    );
    assert.equal((await call(owner, "/api/state")).status, 401);
    assert.equal(
      (
        await call(owner, "/api/login", {
          login: admin.login,
          password: password + "-new",
        })
      ).status,
      200,
    );
    assert.equal((await call(owner, "/api/logout", {})).status, 200);
    assert.equal((await call(owner, "/api/state")).status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  }
});

test("legacy stock stays ahead of known lots across sales, transfers and SQLite reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "alidjone-legacy-fifo-"));
  const path = join(directory, "warehouse.sqlite");
  let store = new Store(path);
  try {
    const x = fixture(),
      product = x.product("other", 100);
    x.state.balances[product][0] = 3;
    x.receipt(product, 0, [], 2, 100);
    store.transaction(() => store.save(store.read(), x.state));
    const mutate = (body) =>
      store.transaction(() => {
        const before = store.read(),
          state = structuredClone(before);
        const result = apply(state, body, admin);
        store.save(before, state);
        return result;
      });
    const post = (type, quantity, extra = {}) => {
      const id = mutate({ action: "create", type, shop: 0, ...extra });
      mutate({ action: "line", id, product, quantity });
      mutate({ action: "post", id });
      return store.read().documents.find((d) => d.id === id);
    };
    assert.equal(post("sale", 1).lines[0].cost, null);
    store.close();
    store = new Store(path);
    const transfer = post("transfer", 1, { to: 1 });
    assert.equal(transfer.lines[0].cost, null);
    mutate({
      action: "accept",
      id: transfer.id,
      lines: [{ line: transfer.lines[0].id, accepted: 1 }],
    });
    store.close();
    store = new Store(path);
    const mixed = post("sale", 2).lines[0];
    assert.equal(mixed.cost, null);
    assert.deepEqual(mixed.lots, [
      { quantity: 1, buy: null },
      { quantity: 1, buy: 100 },
    ]);
    assert.equal(post("sale", 1).lines[0].cost, 100);
    const state = store.read();
    assert.deepEqual(state.balances[product], [0, 1, 0]);
    assert.equal(
      state.lots
        .filter((l) => l.shop === 0)
        .reduce((n, l) => n + l.quantity, 0),
      0,
    );
    assert.equal(state.lots.find((l) => l.shop === 1).buy, null);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
