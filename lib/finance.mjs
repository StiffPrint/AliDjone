import { AccessError, integer, priv, uid, now, audit } from "./warehouse.mjs";

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

export function cashChange(state, body, user) {
  if (!priv(user))
    throw new AccessError(
      "Финансы доступны только руководителю и администратору",
    );
  if (!["opening", "deposit", "withdrawal", "expense"].includes(body.type))
    throw Error("Выберите тип кассовой операции");
  if (!Number.isInteger(body.shop) || body.shop < 0 || body.shop > 2)
    throw Error("Выберите магазин");
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
  state.cash.push(entry);
  audit(state, user, "Кассовая операция: " + reason, { shop: body.shop });
  return entry.id;
}

export function finance(state, user) {
  if (!priv(user))
    throw new AccessError(
      "Финансы доступны только руководителю и администратору",
    );
  const shops = state.shops.map((name, shop) => {
    let revenue = 0,
      refunds = 0,
      knownCost = 0,
      unknownCostUnits = 0,
      cashSales = 0,
      writeoffCost = 0,
      unknownWriteoffUnits = 0;
    for (const document of state.documents.filter(
      (item) => item.shop === shop && item.status === "posted",
    )) {
      if (!["sale", "customer_return", "writeoff"].includes(document.type))
        continue;
      const sign = document.type === "customer_return" ? -1 : 1;
      for (const line of document.lines) {
        const amount = line.quantity * line.sell;
        const cost = costBreakdown(line);
        if (document.type === "writeoff") {
          unknownWriteoffUnits += cost.unknown;
          writeoffCost += cost.known;
          continue;
        }
        if (sign > 0) revenue += amount;
        else refunds += amount;
        const sale =
          document.type === "sale"
            ? document
            : state.documents.find((item) => item.id === document.sale);
        if ((sale?.payment || "cash") === "cash") cashSales += sign * amount;
        unknownCostUnits += sign * cost.unknown;
        knownCost += sign * cost.known;
      }
    }
    const entries = state.cash.filter((item) => item.shop === shop);
    const expenses = entries
      .filter((item) => item.type === "expense")
      .reduce((sum, item) => sum + item.amount, 0);
    const cashAdjustments = entries.reduce(
      (sum, item) =>
        sum +
        (["opening", "deposit"].includes(item.type)
          ? item.amount
          : -item.amount),
      0,
    );
    const netRevenue = revenue - refunds;
    return {
      shop,
      name,
      revenue,
      refunds,
      netRevenue,
      knownCost,
      unknownCostUnits,
      writeoffCost,
      unknownWriteoffUnits,
      expenses,
      profit:
        unknownCostUnits || unknownWriteoffUnits
          ? null
          : netRevenue - knownCost - expenses - writeoffCost,
      cash: cashSales + cashAdjustments,
    };
  });
  return { shops, entries: state.cash.slice().reverse() };
}
