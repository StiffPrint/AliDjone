import { test } from "node:test";
import assert from "node:assert/strict";
import { fresh, apply } from "../lib/warehouse.mjs";
import {
  cashBalance,
  cashChange,
  finance,
  businessDate,
} from "../lib/finance.mjs";
import { createApp } from "../server/server.mjs";
import { validateImport } from "../lib/import-state.mjs";
const admin = { id: "a", name: "Admin", role: "admin", shop: null, active: 1 };
const manager = {
  id: "m",
  name: "Store 1",
  role: "manager",
  shop: 0,
  active: 1,
};
const open = (s, shop, amount) =>
  cashChange(s, { shop, type: "opening", amount, reason: "Opening" }, admin);

test("one linked cash transfer preserves totals and profit; managers can send only from their own cash desk", () => {
  const s = fresh();
  open(s, 0, 10000);
  open(s, 1, 1000);
  const id = cashChange(
    s,
    { type: "transfer", shop: 0, to: 1, amount: 2500, reason: "Change" },
    manager,
  );
  assert.equal(s.cash.filter((e) => e.id === id).length, 1);
  assert.equal(cashBalance(s, 0), 7500);
  assert.equal(cashBalance(s, 1), 3500);
  const report = finance(s, admin);
  assert.equal(
    report.shops.reduce((n, shop) => n + shop.cash, 0),
    11000,
  );
  assert(report.shops.every((shop) => shop.profit === 0));
  assert.equal(s.audit.at(-1).to, 1);
  const before = JSON.stringify(s);
  for (const body of [
    { shop: 1, to: 0, amount: 1 },
    { shop: 0, to: 0, amount: 1 },
    { shop: 0, to: 3, amount: 1 },
    { shop: 0, to: 1, amount: 7501 },
    { shop: 0, to: 1, amount: 0 },
    { shop: 0, to: 1, amount: 1.5 },
  ])
    assert.throws(() =>
      cashChange(s, { type: "transfer", reason: "Test", ...body }, manager),
    );
  assert.equal(JSON.stringify(s), before);
  assert.throws(() =>
    cashChange(
      s,
      { type: "opening", shop: 0, amount: 1, reason: "Test" },
      manager,
    ),
  );
  assert.doesNotThrow(() => validateImport(s));
  const invalidImport = structuredClone(s);
  invalidImport.cash.at(-1).to = 0;
  assert.throws(
    () => validateImport(invalidImport),
    /cash transfer destination/,
  );
});

test("cash access reveals only one's own shop without purchase cost or profit", () => {
  const s = fresh();
  open(s, 0, 1000);
  open(s, 1, 999999);
  cashChange(
    s,
    { type: "transfer", shop: 1, to: 0, amount: 500, reason: "Incoming" },
    admin,
  );
  const report = finance(s, manager);
  assert.deepEqual(
    report.shops.map((shop) => shop.shop),
    [0],
  );
  assert.equal(report.shops[0].cash, 1500);
  for (const key of [
    "profit",
    "knownCost",
    "unknownCostUnits",
    "writeoffCost",
    "unknownWriteoffUnits",
  ])
    assert.equal(key in report.shops[0], false);
  assert.equal(report.entries.length, 2);
  assert(report.entries.every((e) => e.shop === 0 || e.to === 0));
  assert.throws(() => finance(s, manager, { shop: 1 }));
  assert.throws(() => finance(s, admin, { shop: 3 }));
  for (const type of ["deposit", "withdrawal", "expense"])
    assert.doesNotThrow(() =>
      cashChange(s, { type, shop: 0, amount: 10, reason: type }, manager),
    );
  const before = JSON.stringify(s);
  assert.throws(() =>
    cashChange(
      s,
      { type: "withdrawal", shop: 0, amount: 100000, reason: "Too much" },
      manager,
    ),
  );
  assert.equal(JSON.stringify(s), before);
});

test("daily report uses Moscow midnight, separates card/cash, and computes historical cash boundaries", () => {
  const s = fresh(),
    run = (body) => apply(s, body, admin);
  const product = run({
    action: "product",
    product: {
      name: "Case",
      barcode: "CASE",
      kind: "other",
      buy: 100,
      sell: 500,
    },
  });
  const receipt = run({ action: "create", type: "receipt", shop: 0 });
  run({ action: "line", id: receipt, product, quantity: 3 });
  run({ action: "post", id: receipt });
  const sell = (payment, at) => {
    const id = run({ action: "create", type: "sale", shop: 0, payment });
    run({ action: "line", id, product, quantity: 1 });
    run({ action: "post", id });
    s.documents.at(-1).posted = at;
    return id;
  };
  const sale = sell("cash", "2026-11-01T20:59:59.999Z");
  sell("card", "2026-11-01T21:00:00.000Z");
  const ret = run({ action: "create", type: "customer_return", shop: 0, sale });
  run({
    action: "line",
    id: ret,
    product,
    quantity: 1,
    sale_line: s.documents.find((d) => d.id === sale).lines[0].id,
  });
  run({ action: "post", id: ret });
  s.documents.at(-1).posted = "2026-11-02T09:00:00Z";
  open(s, 0, 1000);
  s.cash.at(-1).at = "2026-10-31T12:00:00Z";
  cashChange(
    s,
    { shop: 0, type: "deposit", amount: 300, reason: "Deposit" },
    manager,
  );
  s.cash.at(-1).at = "2026-11-01T10:00:00Z";
  cashChange(
    s,
    { shop: 0, to: 1, type: "transfer", amount: 200, reason: "Transfer" },
    manager,
  );
  s.cash.at(-1).at = "2026-11-01T20:59:00Z";
  cashChange(
    s,
    { shop: 0, type: "expense", amount: 100, reason: "Expense" },
    manager,
  );
  s.cash.at(-1).at = "2026-11-02T12:00:00Z";
  assert.equal(businessDate("2026-11-01T21:00:00Z"), "2026-11-02");
  const first = finance(s, admin, { shop: 0, date: "2026-11-01" });
  const a = first.shops[0];
  assert.equal(a.salesCount, 1);
  assert.equal(a.netRevenue, 500);
  assert.equal(a.profit, 400);
  assert.equal(a.cashSales, 500);
  assert.equal(a.cardSales, 0);
  assert.equal(a.cashOpening, 1000);
  assert.equal(a.cashClosing, 1600);
  assert.equal(a.cashMovement, 600);
  assert.equal(a.cash, 1000);
  assert.equal(first.entries.length, 2);
  const b = finance(s, admin, { shop: 0, date: "2026-11-02" }).shops[0];
  assert.equal(b.salesCount, 1);
  assert.equal(b.returnsCount, 1);
  assert.equal(b.netRevenue, 0);
  assert.equal(b.cashSales, -500);
  assert.equal(b.cardSales, 500);
  assert.equal(b.cashOpening, 1600);
  assert.equal(b.cashClosing, 1000);
  assert.equal(b.profit, -100);
  assert.equal(b.inventoryUnits, 2);
  for (const date of ["2026-02-30", "bad", "2026-1-1"])
    assert.throws(() => finance(s, admin, { date }));
});

test("HTTP cash transfer is atomic, idempotent, scoped and survives duplicate concurrent requests", async () => {
  const origin = "http://127.0.0.1:5194",
    password = "Finance-only-password-934!";
  const app = await createApp({
    database: ":memory:",
    origin,
    adminLogin: "admin",
    adminPassword: password,
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const login = await fetch(base + "/api/login", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ login: "admin", password }),
    });
    const session = await login.json(),
      cookie = login.headers.get("set-cookie").split(";")[0];
    const post = (body, key = crypto.randomUUID()) =>
      fetch(base + "/api/cash", {
        method: "POST",
        headers: {
          Origin: origin,
          Cookie: cookie,
          "Content-Type": "application/json",
          "X-CSRF-Token": session.csrf,
          "Idempotency-Key": key,
        },
        body: JSON.stringify(body),
      });
    assert.equal(
      (
        await post({
          type: "opening",
          shop: 0,
          amount: 1000,
          reason: "Opening",
        })
      ).status,
      200,
    );
    const body = {
        type: "transfer",
        shop: 0,
        to: 1,
        amount: 700,
        reason: "Transfer",
      },
      key = crypto.randomUUID();
    const responses = await Promise.all([post(body, key), post(body, key)]);
    assert(responses.every((r) => r.status === 200));
    assert.equal(app.store.read().cash.length, 2);
    assert.equal(cashBalance(app.store.read(), 0), 300);
    assert.equal(cashBalance(app.store.read(), 1), 700);
    const before = JSON.stringify(app.store.read());
    assert.equal((await post({ ...body, amount: 301 })).status, 400);
    assert.equal(JSON.stringify(app.store.read()), before);
    assert.equal(
      (
        await fetch(base + "/api/finance?shop=bad", {
          headers: { Cookie: cookie },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(base + "/api/finance?date=2026-02-30", {
          headers: { Cookie: cookie },
        })
      ).status,
      400,
    );
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    app.store.close();
  }
});
