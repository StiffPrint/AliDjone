import {
  AccessError,
  integer,
  priv,
  uid,
  now,
  audit,
  qty,
} from "./warehouse.mjs";

const dateFormat = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Moscow",
});
export const businessDate = (value = new Date()) =>
  dateFormat.format(new Date(value));
const validShop = (value) =>
  Number.isInteger(value) && value >= 0 && value <= 2;
function checkShop(user, shop) {
  if (!validShop(shop)) throw Error("Выберите магазин");
  if (!priv(user) && (user.role !== "manager" || user.shop !== shop))
    throw new AccessError("Касса доступна только для вашего магазина");
}
function costBreakdown(line) {
  const parts =
    line.lots ||
    (line.costs &&
      Object.values(line.costs).map((buy) => ({ quantity: 1, buy })));
  if (!parts)
    return {
      known: line.cost ?? 0,
      unknown: line.cost == null ? line.quantity : 0,
    };
  return parts.reduce(
    (total, part) => {
      if (part.buy == null) total.unknown += part.quantity;
      else total.known += part.quantity * part.buy;
      return total;
    },
    { known: 0, unknown: 0 },
  );
}
const cashDelta = (entry, shop) =>
  entry.type === "transfer"
    ? entry.amount * (entry.to === shop ? 1 : entry.shop === shop ? -1 : 0)
    : entry.shop !== shop
      ? 0
      : ["opening", "deposit"].includes(entry.type)
        ? entry.amount
        : -entry.amount;
function documentCash(document, documents) {
  if (!["sale", "customer_return"].includes(document.type)) return 0;
  const sale =
    document.type === "sale" ? document : documents.get(document.sale);
  if ((sale?.payment || "cash") !== "cash") return 0;
  return (
    document.lines.reduce((n, line) => n + line.quantity * line.sell, 0) *
    (document.type === "sale" ? 1 : -1)
  );
}
export function cashBalance(state, shop) {
  const documents = new Map(
    state.documents.map((document) => [document.id, document]),
  );
  return (
    state.documents
      .filter((d) => d.shop === shop && d.status === "posted")
      .reduce((n, d) => n + documentCash(d, documents), 0) +
    state.cash.reduce((n, entry) => n + cashDelta(entry, shop), 0)
  );
}

export function cashChange(state, body, user) {
  checkShop(user, body.shop);
  if (
    !["opening", "deposit", "withdrawal", "expense", "transfer"].includes(
      body.type,
    )
  )
    throw Error("Выберите тип кассовой операции");
  if (body.type === "opening" && !priv(user))
    throw new AccessError(
      "Начальный остаток задаёт администратор или руководитель",
    );
  const amount = integer(
    body.amount,
    "Укажите положительную сумму в копейках",
    1,
  );
  const reason = String(body.reason || "").trim();
  if (!reason || reason.length > 500)
    throw Error("Укажите назначение операции, до 500 символов");
  if (
    body.type === "opening" &&
    state.cash.some(
      (item) => item.type === "opening" && item.shop === body.shop,
    )
  )
    throw Error("Начальный остаток для магазина уже задан");
  if (
    body.type === "transfer" &&
    (!validShop(body.to) || body.to === body.shop)
  )
    throw Error("Выберите другую кассу получателя");
  if (
    ["transfer", "withdrawal", "expense"].includes(body.type) &&
    amount > cashBalance(state, body.shop)
  )
    throw Error("Недостаточно наличных в кассе");
  // Both sides of a transfer are one immutable row, saved with the HTTP
  // idempotency key in the same SQLite transaction.
  const entry = {
    id: uid(),
    at: now(),
    actor: user.name,
    actor_id: user.id,
    shop: body.shop,
    type: body.type,
    amount,
    reason,
  };
  if (body.type === "transfer") entry.to = body.to;
  state.cash.push(entry);
  audit(state, user, "Кассовая операция: " + reason, {
    shop: body.shop,
    to: entry.to,
  });
  return entry.id;
}

export function finance(state, user, options = {}) {
  if (!priv(user) && user.role !== "manager")
    throw new AccessError("Доступ запрещён");
  let shop = options.shop;
  if (shop !== undefined) checkShop(user, shop);
  else if (!priv(user)) {
    checkShop(user, user.shop);
    shop = user.shop;
  }
  const date = options.date || null;
  if (
    date &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date)
  )
    throw Error("Укажите корректную дату");
  const eventDate = (value) => {
    try {
      return businessDate(value);
    } catch {
      return "";
    }
  };
  const inPeriod = (value) => !date || eventDate(value) === date;
  const documents = new Map(
    state.documents.map((document) => [document.id, document]),
  );
  const shops = state.shops.flatMap((name, index) => {
    if (shop !== undefined && index !== shop) return [];
    let revenue = 0,
      refunds = 0,
      knownCost = 0,
      unknownCostUnits = 0,
      writeoffCost = 0,
      unknownWriteoffUnits = 0,
      cashSales = 0,
      cardSales = 0,
      salesCount = 0,
      returnsCount = 0,
      soldUnits = 0,
      cashOpening = 0,
      cashMovement = 0,
      cash = 0;
    const cashEvent = (amount, at) => {
      cash += amount;
      if (!date || eventDate(at) === date) cashMovement += amount;
      if (date && eventDate(at) && eventDate(at) < date) cashOpening += amount;
    };
    for (const document of state.documents.filter(
      (item) => item.shop === index && item.status === "posted",
    )) {
      const at = document.posted || document.created;
      const cashAmount = documentCash(document, documents);
      cashEvent(cashAmount, at);
      if (
        !inPeriod(at) ||
        !["sale", "customer_return", "writeoff"].includes(document.type)
      )
        continue;
      const sign = document.type === "customer_return" ? -1 : 1;
      if (document.type === "sale") salesCount++;
      if (document.type === "customer_return") returnsCount++;
      for (const line of document.lines) {
        const amount = line.quantity * line.sell,
          cost = costBreakdown(line);
        if (document.type === "writeoff") {
          writeoffCost += cost.known;
          unknownWriteoffUnits += cost.unknown;
          continue;
        }
        if (sign > 0) {
          revenue += amount;
          soldUnits += line.quantity;
        } else refunds += amount;
        const sale =
          document.type === "sale" ? document : documents.get(document.sale);
        if ((sale?.payment || "cash") === "cash") cashSales += sign * amount;
        else cardSales += sign * amount;
        knownCost += sign * cost.known;
        unknownCostUnits += sign * cost.unknown;
      }
    }
    const entries = state.cash.filter(
      (entry) =>
        entry.shop === index ||
        (entry.type === "transfer" && entry.to === index),
    );
    for (const entry of entries) cashEvent(cashDelta(entry, index), entry.at);
    const expenses = entries
      .filter((entry) => entry.type === "expense" && inPeriod(entry.at))
      .reduce((n, entry) => n + entry.amount, 0);
    const netRevenue = revenue - refunds;
    const result = {
      shop: index,
      name,
      revenue,
      refunds,
      netRevenue,
      expenses,
      cash,
      cashOpening,
      cashMovement,
      cashClosing: cashOpening + cashMovement,
      cashSales,
      cardSales,
      salesCount,
      returnsCount,
      soldUnits,
      inventoryUnits: state.products.reduce(
        (n, p) => n + qty(state, p.id, index),
        0,
      ),
    };
    if (priv(user))
      Object.assign(result, {
        knownCost,
        unknownCostUnits,
        writeoffCost,
        unknownWriteoffUnits,
        profit:
          unknownCostUnits || unknownWriteoffUnits
            ? null
            : netRevenue - knownCost - expenses - writeoffCost,
      });
    return [result];
  });
  const entries = state.cash
    .filter(
      (entry) =>
        (shop === undefined ||
          entry.shop === shop ||
          (entry.type === "transfer" && entry.to === shop)) &&
        inPeriod(entry.at),
    )
    .slice()
    .reverse();
  return { date, timeZone: "Europe/Moscow", shops, entries };
}
