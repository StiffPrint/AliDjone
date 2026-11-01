import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { fresh, apply } from "../lib/warehouse.mjs";
import { validateImport } from "../lib/import-state.mjs";
import { Store } from "../server/store.mjs";
import { finance } from "../lib/finance.mjs";

const admin = {
  id: "admin",
  login: "admin@example.com",
  name: "Admin",
  role: "admin",
  shop: null,
  active: 1,
};
function fixture() {
  const state = fresh();
  state.staff.push({ ...admin });
  const run = (body) => apply(state, body, admin);
  const accessory = run({
    action: "product",
    product: {
      name: "Case",
      barcode: "CASE",
      kind: "other",
      buy: 100,
      sell: 300,
    },
  });
  const phone = run({
    action: "product",
    product: {
      name: "Phone",
      barcode: "PHONE",
      kind: "phone",
      buy: 1000,
      sell: 2000,
    },
  });
  const receipt = run({ action: "create", type: "receipt", shop: 0 });
  run({ action: "line", id: receipt, product: accessory, quantity: 10 });
  run({ action: "line", id: receipt, product: phone });
  const line = state.documents.at(-1).lines.at(-1).id;
  for (const serial of ["S1", "S2", "S3"])
    run({ action: "scan", id: receipt, line, serial });
  run({ action: "post", id: receipt });
  const sale = run({
    action: "create",
    type: "sale",
    shop: 0,
    payment: "card",
  });
  run({ action: "line", id: sale, product: accessory, quantity: 3 });
  run({ action: "serial_add", id: sale, serial: "S1" });
  run({ action: "post", id: sale });
  const ret = run({ action: "create", type: "customer_return", shop: 0, sale });
  const original = state.documents.find((d) => d.id === sale).lines;
  run({
    action: "line",
    id: ret,
    product: accessory,
    sale_line: original[0].id,
    quantity: 1,
  });
  run({ action: "line", id: ret, product: phone, sale_line: original[1].id });
  run({
    action: "update_line",
    id: ret,
    line: state.documents.at(-1).lines[1].id,
    serial_ids: [state.units[0].id],
  });
  run({ action: "post", id: ret });
  const transfer = run({ action: "create", type: "transfer", shop: 0, to: 1 });
  run({ action: "line", id: transfer, product: accessory, quantity: 4 });
  for (const serial of ["S2", "S3"])
    run({ action: "serial_add", id: transfer, serial });
  run({ action: "post", id: transfer });
  const lines = state.documents.at(-1).lines;
  run({
    action: "accept",
    id: transfer,
    lines: [
      { line: lines[0].id, accepted: 2 },
      { line: lines[1].id, accepted: 1, serial_ids: [state.units[1].id] },
    ],
  });
  return { state, accessory, phone, run, transfer, sale, ret };
}

test("valid snapshot with returns and partial transfers imports without losing finance or inventory", () => {
  const { state } = fixture();
  assert.deepEqual(validateImport(state), state);
  const directory = mkdtempSync(join(tmpdir(), "alidjone-import-"));
  try {
    const input = join(directory, "state.json"),
      target = join(directory, "target.sqlite");
    writeFileSync(input, JSON.stringify(state));
    const result = cli(input, target);
    assert.equal(result.status, 0, result.stderr);
    const store = new Store(target);
    try {
      assert.deepEqual(store.read(), state);
      assert.deepEqual(finance(store.read(), admin), finance(state, admin));
    } finally {
      store.close();
    }
    assert.notEqual(
      cli(input, target).status,
      0,
      "must reject a populated target",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
const cli = (input, target) =>
  spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("../scripts/import-state.mjs", import.meta.url)),
      input,
      target,
    ],
    { encoding: "utf8" },
  );

test("import rejects invalid prices, references, permissions and inconsistent stock", () => {
  const { state, accessory } = fixture();
  const cases = [
    ["negative purchase price", (s) => (s.products[0].buy = -1)],
    ["fractional selling price", (s) => (s.products[0].sell = 1.5)],
    ["negative line price", (s) => (s.documents[0].lines[0].sell = -1)],
    ["negative cost", (s) => (s.documents[1].lines[0].cost = -1)],
    ["wrong cost total", (s) => s.documents[1].lines[0].cost++],
    ["stock mismatch", (s) => s.balances[accessory][0]++],
    [
      "unknown line product",
      (s) => (s.documents[0].lines[0].product = "unknown"),
    ],
    ["wrong unit product", (s) => (s.units[0].product = accessory)],
    ["unknown unit status", (s) => (s.units[0].status = "bad")],
    [
      "sold without sale",
      (s) => {
        s.units[0].status = "sold";
        s.units[0].sale = "missing";
      },
    ],
    ["wrong serial quantity", (s) => s.documents[1].lines[1].quantity++],
    [
      "duplicate serial",
      (s) => (s.units[1].serial = s.units[0].serial.toLowerCase()),
    ],
    [
      "duplicate barcode",
      (s) => (s.products[1].barcode = s.products[0].barcode.toLowerCase()),
    ],
    ["unknown return sale", (s) => (s.documents[2].sale = "missing")],
    ["wrong refund price", (s) => s.documents[2].lines[0].sell++],
    [
      "excess return",
      (s) => {
        const d = structuredClone(s.documents[2]);
        d.id = "duplicate-return";
        d.lines.forEach((l, i) => (l.id = "duplicate-line-" + i));
        s.documents.push(d);
      },
    ],
    ["wrong transfer destination", (s) => (s.documents[3].to = 0)],
    ["wrong transfer status", (s) => (s.documents[3].status = "received")],
    ["excess accepted", (s) => (s.documents[3].lines[0].accepted = 5)],
    ["lots exceed balance", (s) => (s.lots[0].quantity = 100)],
    [
      "negative cash",
      (s) =>
        s.cash.push({
          id: "c",
          type: "expense",
          shop: 0,
          amount: -1,
          reason: "test",
        }),
    ],
    [
      "invalid manager scope",
      (s) => {
        s.staff[0].role = "manager";
        s.staff[0].shop = 3;
      },
    ],
    ["truthy disabled flag", (s) => (s.staff[0].active = "0")],
    ["malformed table", (s) => (s.units = null)],
  ];
  for (const [label, mutate] of cases) {
    const snapshot = structuredClone(state);
    mutate(snapshot);
    assert.throws(() => validateImport(snapshot), undefined, label);
  }
});

test("import rejects unbacked positive-price sale and validates explicit legacy opening balances", () => {
  const s = fresh();
  s.staff = [{ ...admin }];
  const run = (body) => apply(s, body, admin);
  const p = run({
    action: "product",
    product: { name: "Case", barcode: "C", kind: "other", buy: 100, sell: 200 },
  });
  s.balances[p][0] = 3;
  assert.doesNotThrow(
    () => validateImport(s),
    "legacy snapshot with no movements remains supported",
  );
  const id = run({ action: "create", type: "sale", shop: 0 });
  run({ action: "line", id, product: p, quantity: 1 });
  run({ action: "post", id });
  assert.throws(() => validateImport(s), /stock history\/balance mismatch/);
  const validated = validateImport({
    ...s,
    openingBalances: { [p]: [3, 0, 0] },
  });
  assert.deepEqual(validated, s);
  assert.throws(() =>
    validateImport({ ...s, openingBalances: { [p]: [2, 0, 0] } }),
  );
});

test("invalid import is rejected before touching a new or existing database", () => {
  const directory = mkdtempSync(join(tmpdir(), "alidjone-invalid-import-"));
  try {
    const { state } = fixture();
    state.products[0].buy = -500;
    const input = join(directory, "bad.json"),
      target = join(directory, "new.sqlite");
    writeFileSync(input, JSON.stringify(state));
    assert.notEqual(cli(input, target).status, 0);
    assert.equal(existsSync(target), false);
    const store = new Store(target);
    const before = store.read();
    before.cash.push({ id: "keep", amount: 100 });
    store.transaction(() => store.save(store.read(), before));
    store.close();
    assert.notEqual(cli(input, target).status, 0);
    const reopened = new Store(target);
    try {
      assert.deepEqual(reopened.read(), before);
    } finally {
      reopened.close();
    }
    state.products[0].buy = 100;
    writeFileSync(input, JSON.stringify(state));
    assert.notEqual(
      cli(input, target).status,
      0,
      "cash-only target is not empty",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("password fields are stripped and account flags normalized without mutating source", () => {
  const s = fresh();
  s.staff = [
    { ...admin, active: true, password: "plaintext", password_hash: "old" },
  ];
  const out = validateImport(s);
  assert.equal(out.staff[0].active, 1);
  assert.equal("password" in out.staff[0], false);
  assert.equal("password_hash" in out.staff[0], false);
  assert.equal(s.staff[0].password, "plaintext");
});
