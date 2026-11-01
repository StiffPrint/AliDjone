import { fresh, integer, validLogin } from "./warehouse.mjs";

const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const requireValid = (condition, message) => {
  if (!condition) throw Error("Invalid import: " + message);
};
const text = (value, max = 200) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;
const shop = (value) => Number.isInteger(value) && value >= 0 && value <= 2;
const money = (value, nullable = false) => {
  if (nullable && value === null) return;
  integer(value, "Invalid import: price/cost must be a nonnegative integer");
};
const unique = (values, label) =>
  requireValid(new Set(values).size === values.length, "duplicate " + label);
const normalize = (value) => value.trim().toLowerCase();
const amounts = (values, label) => {
  requireValid(Array.isArray(values) && values.length === 3, label);
  values.forEach((value) => integer(value, "Invalid import: " + label));
};
const isPosted = (document) =>
  !["draft", "cancelled"].includes(document.status);

// Validate the complete snapshot before the CLI opens the target database.
export function validateImport(imported) {
  requireValid(object(imported), "snapshot must be an object");
  const state = { ...fresh(), ...structuredClone(imported) };
  const maps = {};
  for (const table of [
    "products",
    "units",
    "documents",
    "staff",
    "audit",
    "cash",
    "lots",
  ]) {
    requireValid(Array.isArray(state[table]), "table " + table);
    for (const item of state[table])
      requireValid(
        object(item) && text(item.id, 100) && !/["'<>]/.test(item.id),
        "ID in " + table,
      );
    unique(
      state[table].map((item) => item.id),
      table + " IDs",
    );
    maps[table] = new Map(state[table].map((item) => [item.id, item]));
  }
  requireValid(object(state.balances), "balances");
  if (imported.shops !== undefined)
    requireValid(
      JSON.stringify(imported.shops) === JSON.stringify(fresh().shops),
      "unsupported shops",
    );
  for (const product of state.products) {
    requireValid(
      text(product.name) && text(product.barcode, 100),
      "product name/barcode",
    );
    requireValid(["phone", "other"].includes(product.kind), "product kind");
    money(product.buy, true);
    money(product.sell);
    amounts(state.balances[product.id], "product balance");
  }
  for (const id of Object.keys(state.balances))
    requireValid(maps.products.has(id), "unknown balance product");
  unique(
    state.products.map((item) => normalize(item.barcode)),
    "barcodes",
  );
  for (const user of state.staff) {
    requireValid(
      validLogin(user.login) && text(user.name, 100),
      "staff login/name",
    );
    user.login = normalize(user.login);
    requireValid(
      ["admin", "leader", "manager"].includes(user.role),
      "staff role",
    );
    requireValid(
      user.role === "manager" ? shop(user.shop) : user.shop === null,
      "staff shop",
    );
    requireValid(
      [0, 1, false, true].includes(user.active),
      "staff active flag",
    );
    user.active = user.active ? 1 : 0;
    delete user.password;
    delete user.password_hash;
  }
  unique(
    state.staff.map((user) => user.login),
    "staff logins",
  );
  for (const unit of state.units) {
    requireValid(
      maps.products.get(unit.product)?.kind === "phone",
      "unit product",
    );
    requireValid(text(unit.serial, 100), "unit serial");
    requireValid(
      [
        "available",
        "sold",
        "transit",
        "written_off",
        "supplier_return",
      ].includes(unit.status),
      "unit status",
    );
    requireValid(
      unit.status === "transit" ? unit.shop === null : shop(unit.shop),
      "unit shop",
    );
    money(unit.buy, true);
  }
  unique(
    state.units.map((unit) => normalize(unit.serial)),
    "serials",
  );
  const unitsBySerial = new Map(
    state.units.map((unit) => [normalize(unit.serial), unit]),
  );
  const receiptCounts = new Map(),
    serialChanges = new Map();
  const lineIds = [],
    returns = new Map(),
    returnedUnits = new Set(),
    receiptSerials = new Set();
  const movement = new Map(),
    touched = new Set();
  const move = (product, at, quantity) => {
    if (!movement.has(product)) movement.set(product, [0, 0, 0]);
    movement.get(product)[at] += quantity;
    requireValid(
      Number.isSafeInteger(movement.get(product)[at]),
      "stock movement overflow",
    );
    touched.add(product);
  };
  for (const document of state.documents) {
    requireValid(
      [
        "receipt",
        "sale",
        "transfer",
        "customer_return",
        "supplier_return",
        "writeoff",
      ].includes(document.type),
      "document type",
    );
    const transfer = document.type === "transfer",
      posted = isPosted(document);
    requireValid(
      (transfer
        ? ["draft", "cancelled", "in_transit", "partial", "received"]
        : ["draft", "cancelled", "posted"]
      ).includes(document.status),
      "document status",
    );
    requireValid(
      shop(document.shop) &&
        (transfer
          ? shop(document.to) && document.to !== document.shop
          : document.to === null),
      "document shops",
    );
    requireValid(
      Array.isArray(document.lines) &&
        document.lines.length <= 500 &&
        (!posted || document.lines.length > 0),
      "document lines",
    );
    if (document.type === "sale")
      requireValid(["cash", "card"].includes(document.payment), "sale payment");
    if (posted && ["writeoff", "supplier_return"].includes(document.type))
      requireValid(text(document.reason, 1000), "document reason");
    let sale;
    if (document.type === "customer_return") {
      sale = maps.documents.get(document.sale);
      requireValid(
        sale?.type === "sale" &&
          sale.status === "posted" &&
          sale.shop === document.shop,
        "return sale reference",
      );
      requireValid(Array.isArray(sale.lines), "sale lines");
    }
    const products = [];
    for (const line of document.lines) {
      requireValid(
        object(line) && text(line.id, 100) && !/["'<>]/.test(line.id),
        "line ID",
      );
      lineIds.push(line.id);
      const product = maps.products.get(line.product),
        phone = product?.kind === "phone";
      requireValid(!!product, "line product");
      products.push(line.product);
      integer(
        line.quantity,
        "Invalid import: line quantity",
        posted || !phone ? 1 : 0,
      );
      money(line.buy, true);
      money(line.sell);
      money(line.quantity * line.sell);
      requireValid(
        Array.isArray(line.serials) &&
          line.serials.every((value) => text(value, 100)),
        "receipt serials",
      );
      unique(line.serials.map(normalize), "receipt serials");
      requireValid(
        Array.isArray(line.serial_ids) &&
          line.serial_ids.every(
            (id) => maps.units.get(id)?.product === product.id,
          ),
        "line serial references",
      );
      unique(line.serial_ids, "line serial IDs");
      if (phone) {
        requireValid(
          line.quantity ===
            (document.type === "receipt"
              ? line.serials.length
              : line.serial_ids.length),
          "serial quantity",
        );
        if (document.type === "receipt" && document.status !== "cancelled")
          for (const serial of line.serials) {
            const key = normalize(serial);
            requireValid(
              !receiptSerials.has(key),
              "serial in multiple receipts",
            );
            receiptSerials.add(key);
            const unit = unitsBySerial.get(key);
            requireValid(
              posted ? unit?.product === product.id : !unit,
              "receipt unit reference",
            );
            if (posted)
              receiptCounts.set(unit.id, (receiptCounts.get(unit.id) || 0) + 1);
          }
      } else
        requireValid(
          line.serials.length === 0 && line.serial_ids.length === 0,
          "accessory serials",
        );
      if (line.cost !== undefined) money(line.cost, true);
      if (line.costs !== undefined) {
        requireValid(object(line.costs) && phone, "serial costs");
        requireValid(
          Object.keys(line.costs).length === line.serial_ids.length &&
            line.serial_ids.every((id) => Object.hasOwn(line.costs, id)),
          "cost serial references",
        );
        Object.values(line.costs).forEach((value) => money(value, true));
      }
      if (line.lots !== undefined) {
        requireValid(Array.isArray(line.lots) && !phone, "line lots");
        for (const lot of line.lots) {
          requireValid(object(lot), "line lot");
          integer(lot.quantity, "Invalid import: lot quantity", 1);
          money(lot.buy, true);
        }
        requireValid(
          line.lots.reduce((n, lot) => n + lot.quantity, 0) === line.quantity,
          "line lot quantities",
        );
      }
      const parts =
        line.lots ||
        (line.costs &&
          Object.values(line.costs).map((buy) => ({ quantity: 1, buy })));
      if (posted && document.type !== "receipt" && line.cost !== undefined)
        requireValid(!!parts, "cost without purchase details");
      if (parts && line.cost !== undefined) {
        const expected = parts.some((part) => part.buy === null)
          ? null
          : parts.reduce((n, part) => n + part.quantity * part.buy, 0);
        requireValid(line.cost === expected, "line cost total");
      }
      if (sale) {
        const original = sale.lines.find((item) => item.id === line.sale_line);
        requireValid(
          original?.product === product.id && original.sell === line.sell,
          "return line reference/price",
        );
        if (phone)
          requireValid(
            line.serial_ids.every((id) => original.serial_ids.includes(id)),
            "return serial reference",
          );
        if (posted) {
          const count = (returns.get(original.id) || 0) + line.quantity;
          returns.set(original.id, count);
          requireValid(count <= original.quantity, "excess return quantity");
          // A serial can be returned again only after a different sale.
          for (const id of line.serial_ids) {
            const key = sale.id + ":" + id;
            requireValid(!returnedUnits.has(key), "duplicate serial return");
            returnedUnits.add(key);
          }
        }
      }
      if (transfer) {
        const accepted = line.accepted ?? 0;
        integer(accepted, "Invalid import: accepted quantity");
        requireValid(
          accepted <= line.quantity && (posted || accepted === 0),
          "accepted quantity",
        );
        if (phone) {
          const ids = line.accepted_ids ?? [];
          requireValid(
            Array.isArray(ids) &&
              ids.length === accepted &&
              ids.every((id) => line.serial_ids.includes(id)),
            "accepted serials",
          );
          unique(ids, "accepted serials");
        }
      }
      if (posted && !phone) {
        move(
          product.id,
          document.shop,
          ["receipt", "customer_return"].includes(document.type)
            ? line.quantity
            : -line.quantity,
        );
        if (transfer) move(product.id, document.to, line.accepted ?? 0);
      }
      if (posted && phone) {
        const change =
          document.type === "customer_return"
            ? 1
            : ["sale", "writeoff", "supplier_return"].includes(document.type)
              ? -1
              : 0;
        for (const id of line.serial_ids)
          serialChanges.set(id, (serialChanges.get(id) || 0) + change);
      }
    }
    unique(products, "products in document");
    if (transfer && posted) {
      const all = document.lines.every(
        (line) => (line.accepted ?? 0) === line.quantity,
      );
      const any = document.lines.some((line) => (line.accepted ?? 0) > 0);
      requireValid(
        document.status === "received"
          ? all
          : document.status === "in_transit"
            ? !any
            : !all,
        "transfer status/receipt mismatch",
      );
    }
  }
  unique(lineIds, "line IDs");
  for (const unit of state.units) {
    const receipts = receiptCounts.get(unit.id) || 0,
      change = serialChanges.get(unit.id) || 0;
    // Units with no receipt may come from explicitly numbered legacy stock.
    requireValid(
      (receipts || 1) + change ===
        (["available", "transit"].includes(unit.status) ? 1 : 0),
      "unit status/history mismatch",
    );
    if (unit.status === "sold") {
      const sale = maps.documents.get(unit.sale);
      requireValid(
        sale?.type === "sale" &&
          sale.status === "posted" &&
          sale.shop === unit.shop &&
          sale.lines.some((line) => line.serial_ids.includes(unit.id)),
        "sold unit sale",
      );
      requireValid(
        !returnedUnits.has(sale.id + ":" + unit.id),
        "returned unit still sold",
      );
    }
    if (unit.status === "transit") {
      const transfer = maps.documents.get(unit.transfer);
      requireValid(
        transfer?.type === "transfer" &&
          ["in_transit", "partial"].includes(transfer.status) &&
          transfer.lines.some(
            (line) =>
              line.serial_ids.includes(unit.id) &&
              !(line.accepted_ids || []).includes(unit.id),
          ),
        "unit transfer",
      );
    }
  }
  const opening = imported.openingBalances ?? {};
  requireValid(object(opening), "openingBalances");
  for (const [id, values] of Object.entries(opening)) {
    requireValid(
      maps.products.get(id)?.kind === "other",
      "opening balance product",
    );
    amounts(values, "opening balance");
  }
  for (const id of new Set([...touched, ...Object.keys(opening)])) {
    const delta = movement.get(id) || [0, 0, 0],
      initial = opening[id] || [0, 0, 0];
    requireValid(
      delta.every(
        (value, i) =>
          Number.isSafeInteger(value + initial[i]) &&
          value + initial[i] === state.balances[id][i],
      ),
      "stock history/balance mismatch for " +
        id +
        "; specify openingBalances for legacy stock",
    );
  }
  const tracked = new Map();
  for (const lot of state.lots) {
    requireValid(
      maps.products.get(lot.product)?.kind === "other" && shop(lot.shop),
      "lot product/shop",
    );
    integer(lot.quantity, "Invalid import: lot quantity");
    money(lot.buy, true);
    const key = lot.product + ":" + lot.shop,
      count = (tracked.get(key) || 0) + lot.quantity;
    tracked.set(key, count);
    requireValid(
      count <= state.balances[lot.product][lot.shop],
      "lots exceed stock",
    );
  }
  const openings = new Set();
  for (const entry of state.cash) {
    requireValid(
      shop(entry.shop) &&
        ["opening", "deposit", "withdrawal", "expense"].includes(entry.type) &&
        text(entry.reason, 500),
      "cash entry",
    );
    integer(entry.amount, "Invalid import: cash amount", 1);
    if (entry.type === "opening") {
      requireValid(!openings.has(entry.shop), "duplicate cash opening");
      openings.add(entry.shop);
    }
  }
  delete state.openingBalances;
  // Store.read uses the application's fixed shop list and current schema.
  state.shops = fresh().shops;
  state.version = fresh().version;
  return state;
}
