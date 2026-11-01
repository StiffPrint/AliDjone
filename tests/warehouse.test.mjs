import { test } from "node:test";
import assert from "node:assert/strict";
import { fresh, apply, view, qty, staffChange } from "../lib/warehouse.mjs";
const admin = {
    id: "a",
    login: "admin@example.com",
    name: "Admin",
    role: "admin",
    shop: null,
    active: 1,
  },
  manager = {
    id: "m",
    login: "m@example.com",
    name: "Manager",
    role: "manager",
    shop: 0,
    active: 1,
  },
  receiver = { ...manager, id: "r", shop: 1 };
function fixture() {
  let state = fresh();
  state.staff = [admin, manager, receiver];
  const run = (b, u = admin) => {
    const copy = structuredClone(state),
      r = apply(copy, b, u);
    state = copy;
    return r;
  };
  const get = () => state;
  const phone = run({
      action: "product",
      product: {
        name: "Phone",
        barcode: "001",
        kind: "phone",
        buy: null,
        sell: 10000,
      },
    }),
    acc = run({
      action: "product",
      product: {
        name: "Case",
        barcode: "002",
        kind: "other",
        buy: 100,
        sell: 200,
      },
    });
  const create = (type, extra = {}) =>
    run({ action: "create", type, shop: 0, ...extra });
  const line = (id, product, quantity = 1, extra = {}) => {
    run({ action: "line", id, product, quantity, ...extra });
    return get()
      .documents.find((d) => d.id === id)
      .lines.at(-1).id;
  };
  const receipt = () => {
    const d = create("receipt"),
      l = line(d, phone);
    for (const serial of ["S1", "S2"])
      run({ action: "scan", id: d, line: l, serial });
    line(d, acc, 10);
    run({ action: "post", id: d });
    return d;
  };
  return { run, get, phone, acc, create, line, receipt };
}
test("receipt draft and global duplicate control; post is idempotent", () => {
  const x = fixture(),
    d = x.create("receipt"),
    l = x.line(d, x.phone);
  x.run({ action: "scan", id: d, line: l, serial: "S1" });
  assert.equal(qty(x.get(), x.phone, 0), 0);
  assert.throws(() =>
    x.run({ action: "scan", id: d, line: l, serial: " s1 " }),
  );
  const other = x.create("receipt"),
    ol = x.line(other, x.phone);
  assert.throws(() =>
    x.run({ action: "scan", id: other, line: ol, serial: "S1" }),
  );
  x.run({ action: "post", id: d });
  x.run({ action: "post", id: d });
  assert.equal(qty(x.get(), x.phone, 0), 1);
});
test("transfer in transit, partial receive, receiver permissions and retry", () => {
  const x = fixture();
  x.receipt();
  const ids = x.get().units.map((u) => u.id),
    d = x.create("transfer", { to: 1 }),
    lp = x.line(d, x.phone),
    la = x.line(d, x.acc, 5);
  x.run({ action: "update_line", id: d, line: lp, serial_ids: ids });
  x.run({ action: "post", id: d }, manager);
  assert.equal(qty(x.get(), x.phone, 0), 0);
  assert.equal(qty(x.get(), x.phone, 1), 0);
  const request = {
    action: "accept",
    id: d,
    lines: [
      { line: lp, accepted: 1, serial_ids: ids.slice(0, 1) },
      { line: la, accepted: 2 },
    ],
  };
  assert.throws(() => x.run(request, manager));
  x.run(request, receiver);
  x.run(request, receiver);
  assert.equal(qty(x.get(), x.phone, 1), 1);
  assert.deepEqual(x.get().balances[x.acc], [5, 2, 0]);
  request.lines = [
    { line: lp, accepted: 2, serial_ids: ids },
    { line: la, accepted: 5 },
  ];
  x.run(request, receiver);
  x.run(request, receiver);
  assert.equal(qty(x.get(), x.phone, 1), 2);
  assert.deepEqual(x.get().balances[x.acc], [5, 5, 0]);
});
test("sale, linked return, repeated return rejected, writeoff", () => {
  const x = fixture();
  x.receipt();
  const ids = x.get().units.map((u) => u.id),
    sale = x.create("sale"),
    sp = x.line(sale, x.phone),
    sa = x.line(sale, x.acc, 3);
  x.run({
    action: "update_line",
    id: sale,
    line: sp,
    serial_ids: ids,
    sell: 9000,
  });
  x.run({ action: "post", id: sale });
  const ret = x.create("customer_return", { sale }),
    rp = x.line(ret, x.phone, 1, { sale_line: sp });
  x.line(ret, x.acc, 2, { sale_line: sa });
  x.run({
    action: "update_line",
    id: ret,
    line: rp,
    serial_ids: ids.slice(0, 1),
  });
  x.run({ action: "post", id: ret });
  x.run({ action: "post", id: ret });
  assert.equal(qty(x.get(), x.phone, 0), 1);
  assert.equal(qty(x.get(), x.acc, 0), 9);
  const dup = x.create("customer_return", { sale }),
    dl = x.line(dup, x.phone, 1, { sale_line: sp });
  assert.throws(() =>
    x.run({
      action: "update_line",
      id: dup,
      line: dl,
      serial_ids: ids.slice(0, 1),
    }),
  );
  assert.throws(() => x.run({ action: "post", id: dup }));
  const wd = x.create("writeoff", { reason: "Broken" }),
    wl = x.line(wd, x.phone);
  x.run({
    action: "update_line",
    id: wd,
    line: wl,
    serial_ids: ids.slice(0, 1),
  });
  x.run({ action: "post", id: wd });
  assert.equal(qty(x.get(), x.phone, 0), 0);
});
test("manager redaction and blocked price/store mutations", () => {
  const x = fixture();
  x.receipt();
  const out = view(x.get(), manager);
  assert(out.products.every((p) => !("buy" in p)));
  assert(out.units.every((u) => !("buy" in u)));
  assert(out.documents.every((d) => d.lines.every((l) => !("buy" in l))));
  assert(!("staff" in out));
  assert.throws(() => x.create("sale", { shop: 4 }));
  assert.throws(() =>
    x.run({ action: "create", type: "sale", shop: 1 }, manager),
  );
  assert.throws(() =>
    x.run(
      {
        action: "product",
        product: {
          id: x.phone,
          name: "x",
          barcode: "1",
          kind: "phone",
          buy: 2,
          sell: 3,
        },
      },
      manager,
    ),
  );
  assert.throws(() =>
    staffChange(
      x.get(),
      { login: "a@example.com", name: "a", role: "leader" },
      manager,
    ),
  );
});
test("stock failure is atomic and cancelled receipt releases reserved numbers", () => {
  const x = fixture();
  x.receipt();
  const d = x.create("sale");
  x.line(d, x.acc, 11);
  const before = JSON.stringify(x.get());
  assert.throws(() => x.run({ action: "post", id: d }));
  assert.equal(JSON.stringify(x.get()), before);
  const rd = x.create("receipt"),
    rl = x.line(rd, x.phone);
  x.run({ action: "scan", id: rd, line: rl, serial: "NEW" });
  x.run({ action: "cancel", id: rd });
  const other = x.create("receipt"),
    ol = x.line(other, x.phone);
  x.run({ action: "scan", id: other, line: ol, serial: "NEW" });
});
test("supplier return, reason required and admin cannot revoke own access", () => {
  const x = fixture();
  x.receipt();
  const d = x.create("supplier_return", { reason: "Faulty" });
  x.line(d, x.acc, 2);
  x.run({ action: "post", id: d });
  assert.equal(qty(x.get(), x.acc, 0), 8);
  const wd = x.create("writeoff");
  x.line(wd, x.acc);
  assert.throws(() => x.run({ action: "post", id: wd }));
  assert.throws(() =>
    staffChange(
      x.get(),
      { id: "a", login: admin.login, name: "Admin", role: "manager", shop: 0 },
      admin,
    ),
  );
});
