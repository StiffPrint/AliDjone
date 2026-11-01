export const uid = () => crypto.randomUUID();
export const now = () => new Date().toISOString();
export const fresh = () => ({
  version: 6,
  shops: ["Островок", "Центральный", "Магазин 2"],
  products: [],
  units: [],
  balances: {},
  documents: [],
  audit: [],
  staff: [],
  cash: [],
  lots: [],
});
export class AccessError extends Error {}
export const validLogin = (value) =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= 200 &&
  !/[\u0000-\u001f\u007f]/.test(value);
export const integer = (
  v,
  msg = "Укажите целое неотрицательное число",
  min = 0,
) => {
  if (!Number.isSafeInteger(v) || v < min || v > 1e12) throw Error(msg);
  return v;
};
const price = (v, nullable = false) =>
  nullable && v === null ? null : integer(v, "Проверьте цену");
const shop = (v) => {
  if (!Number.isInteger(v) || v < 0 || v > 2) throw Error("Выберите магазин");
  return v;
};
export const priv = (u) => ["admin", "leader"].includes(u.role);
const access = (u, s) => {
  shop(s);
  if (u.role === "manager" && u.shop !== s)
    throw new AccessError("Операция доступна только для вашего магазина");
};
export const find = (arr, id, label) => {
  const x = arr.find((x) => x.id === id);
  if (!x) throw Error(label + " не найден");
  return x;
};
export const qty = (s, p, store) =>
  s.balances[p][store] +
  s.units.filter(
    (u) => u.product === p && u.shop === store && u.status === "available",
  ).length;
export const audit = (s, u, action, d = null) =>
  s.audit.push({
    id: uid(),
    at: now(),
    actor: u.name,
    actor_id: u.id,
    shop: d?.shop ?? null,
    to: d?.to ?? null,
    action,
    document: d?.id ?? null,
  });
export function view(s, u) {
  const out = structuredClone(s);
  delete out.staff;
  delete out.cash;
  delete out.lots;
  if (!priv(u)) {
    out.documents = out.documents.filter(
      (d) => d.shop === u.shop || (d.type === "transfer" && d.to === u.shop),
    );
    const referenced = new Set(
      out.documents.flatMap((d) => d.lines.flatMap((l) => l.serial_ids || [])),
    );
    out.units = out.units
      .filter((item) => item.shop === u.shop || referenced.has(item.id))
      .map((item) =>
        item.shop === u.shop || item.status === "transit"
          ? item
          : {
              id: item.id,
              product: item.product,
              serial: item.serial,
              shop: null,
              status: "history",
            },
      );
    out.audit = out.audit
      .filter((a) => a.shop === u.shop || a.to === u.shop)
      .map(({ before, after, changes, ...event }) => event);
    for (const p of out.products) delete p.buy;
    for (const item of out.units) delete item.buy;
    for (const d of out.documents)
      for (const l of d.lines) {
        delete l.buy;
        delete l.costs;
        delete l.cost;
        delete l.lots;
      }
    for (const key of Object.keys(out.balances))
      out.balances[key] = out.balances[key].map((n, i) =>
        i === u.shop ? n : 0,
      );
  }
  for (const p of out.products)
    p.quantities = [0, 1, 2].map((i) =>
      !priv(u) && i !== u.shop ? 0 : qty(s, p.id, i),
    );
  out.user = publicUser(u);
  return out;
}
export const publicUser = (u) => ({
  id: u.id,
  login: u.login,
  name: u.name,
  role: u.role,
  shop: u.shop,
  active: u.active,
});
const normalize = (v) => v.trim().toLowerCase();
function serialCheck(s, raw, ignoreDoc = null) {
  if (typeof raw !== "string" || !raw.trim() || raw.trim().length > 100)
    throw Error("Проверьте серийный номер");
  const v = raw.trim(),
    n = normalize(v);
  if (s.units.some((u) => normalize(u.serial) === n))
    throw Error(
      "Этот номер уже есть в базе. Для возврата используйте документ возврата.",
    );
  if (
    s.documents.some(
      (d) =>
        d.id !== ignoreDoc &&
        d.type === "receipt" &&
        d.status === "draft" &&
        d.lines.some((l) => l.serials.some((x) => normalize(x) === n)),
    )
  )
    throw Error("Номер уже внесён в другую приёмку");
  return v;
}
function selectUnits(s, p, line, status = "available", store = null) {
  const ids = line.serial_ids || [];
  if (
    !Array.isArray(ids) ||
    ids.some((x) => typeof x !== "string") ||
    new Set(ids).size !== ids.length
  )
    throw Error("Проверьте выбранные экземпляры");
  const units = ids.map((i) => find(s.units, i, "Экземпляр"));
  if (
    units.some(
      (u) =>
        u.product !== p.id ||
        u.status !== status ||
        (store !== null && u.shop !== store),
    )
  )
    throw Error("Один из экземпляров уже недоступен в выбранном магазине");
  return units;
}
export function staffChange(s, b, u) {
  if (u.role !== "admin")
    throw new AccessError("Только администратор управляет сотрудниками");
  const login = String(b.login || "")
      .trim()
      .toLowerCase(),
    name = String(b.name || "").trim(),
    role = b.role;
  if (!validLogin(login) || !name || name.length > 100)
    throw Error("Укажите логин сотрудника и имя");
  if (!["admin", "leader", "manager"].includes(role))
    throw Error("Укажите роль");
  const store = role === "manager" ? shop(b.shop) : null,
    old = b.id ? find(s.staff, b.id, "Сотрудник") : null,
    active = b.active === false ? 0 : 1;
  if (s.staff.some((x) => x.id !== old?.id && x.login === login))
    throw Error("Этот логин уже добавлен");
  if (old?.id === u.id && (role !== "admin" || !active || login !== u.login))
    throw Error("Нельзя отключить или изменить свой доступ администратора");
  const previous = old ? publicUser(old) : null;
  if (old) Object.assign(old, { login, name, role, shop: store, active });
  else s.staff.push({ id: uid(), login, name, role, shop: store, active });
  audit(s, u, "Изменение доступа сотрудника: " + name);
  s.audit.at(-1).before = previous;
  s.audit.at(-1).after = publicUser(old || s.staff.at(-1));
  return old?.id ?? s.staff.at(-1).id;
}
function applyAction(s, b, u) {
  const a = b.action;
  if (a === "serial_add") {
    const d = find(s.documents, b.id, "Документ");
    access(u, d.shop);
    if (
      d.status !== "draft" ||
      !["sale", "writeoff", "supplier_return", "transfer"].includes(d.type)
    )
      throw Error(
        "Номер можно добавить только в черновик расходного документа",
      );
    if (typeof b.serial !== "string" || !b.serial.trim())
      throw Error("Введите серийный номер");
    const item = s.units.find(
      (x) =>
        normalize(x.serial) === normalize(b.serial) &&
        x.status === "available" &&
        x.shop === d.shop,
    );
    if (!item)
      throw Error("Телефон с этим номером недоступен на выбранной точке");
    const p = find(s.products, item.product, "Позиция");
    let l = d.lines.find((x) => x.product === p.id);
    if (!l) {
      applyAction(s, { action: "line", id: d.id, product: p.id }, u);
      l = d.lines.at(-1);
    }
    if (l.serial_ids.includes(item.id))
      throw Error("Этот серийный номер уже добавлен");
    l.serial_ids.push(item.id);
    l.quantity = l.serial_ids.length;
    return d.id;
  }

  if (a === "product") {
    if (!priv(u))
      throw new AccessError(
        "Каталог изменяет только руководитель или администратор",
      );
    const raw = b.product || {},
      p = raw.id ? find(s.products, raw.id, "Позиция") : null,
      name = String(raw.name || "").trim(),
      barcode = String(raw.barcode || "").trim(),
      kind = raw.kind;
    if (
      !name ||
      !barcode ||
      name.length > 200 ||
      barcode.length > 100 ||
      !["phone", "other"].includes(kind)
    )
      throw Error("Укажите название, штрих-код и тип");
    if (
      s.products.some(
        (x) => x.id !== p?.id && normalize(x.barcode) === normalize(barcode),
      )
    )
      throw Error("Этот штрих-код уже используется");
    if (
      p &&
      kind !== p.kind &&
      (s.units.some((x) => x.product === p.id) ||
        s.documents.some((d) => d.lines.some((l) => l.product === p.id)))
    )
      throw Error("Нельзя менять тип позиции с историей");
    if ("buy" in raw && !priv(u))
      throw new AccessError("Закупочная цена недоступна");
    const fields = {
      name,
      barcode,
      kind,
      sell: price(raw.sell),
      buy: priv(u) ? price(raw.buy ?? null, true) : (p?.buy ?? null),
    };
    let id;
    if (p) {
      Object.assign(p, fields);
      id = p.id;
    } else {
      id = uid();
      s.products.push({ id, ...fields });
      s.balances[id] = [0, 0, 0];
    }
    audit(s, u, "Изменение позиции: " + name);
    return id;
  }
  if (a === "create") {
    const kind = b.type,
      store = shop(b.shop);
    access(u, store);
    if (
      ![
        "receipt",
        "transfer",
        "sale",
        "customer_return",
        "supplier_return",
        "writeoff",
      ].includes(kind)
    )
      throw Error("Неизвестный тип документа");
    const to = kind === "transfer" ? shop(b.to) : null;
    if (to === store) throw Error("Выберите другой магазин");
    const d = {
      id: uid(),
      number: s.documents.length + 1,
      type: kind,
      status: "draft",
      shop: store,
      to,
      created: now(),
      actor: u.name,
      actor_id: u.id,
      payment:
        kind === "sale"
          ? ["cash", "card"].includes(b.payment)
            ? b.payment
            : "cash"
          : null,
      lines: [],
      reason: String(b.reason || "").slice(0, 1000),
      sale: b.sale ?? null,
    };
    if (kind === "customer_return") {
      const sale = find(s.documents, d.sale, "Продажа");
      if (sale.type !== "sale" || sale.status !== "posted")
        throw Error("Выберите проведённую продажу");
      if (sale.shop !== store)
        throw new AccessError(
          "Возврат оформляется в магазине исходной продажи",
        );
    }
    s.documents.push(d);
    audit(s, u, "Создан документ", d);
    return d.id;
  }
  if (a === "attach_legacy") {
    const p = find(s.products, b.product, "Позиция"),
      store = shop(b.shop);
    access(u, store);
    const values = b.serials;
    if (
      p.kind !== "phone" ||
      !Array.isArray(values) ||
      !values.length ||
      values.length > s.balances[p.id][store]
    )
      throw Error("Проверьте число номеров прежнего остатка");
    for (const raw of values) {
      const value = serialCheck(s, raw);
      s.units.push({
        id: uid(),
        product: p.id,
        serial: value,
        shop: store,
        status: "available",
        buy: p.buy,
      });
      s.balances[p.id][store]--;
    }
    audit(s, u, "Уточнение прежнего остатка: " + p.name);
    return p.id;
  }
  const d = find(s.documents, b.id, "Документ");
  if (a === "accept") {
    if (
      d.type !== "transfer" ||
      !["in_transit", "partial", "received"].includes(d.status)
    )
      throw Error("Перемещение ещё не отправлено");
    access(u, d.to);
    if (d.status === "received") return d.id;
    if (!Array.isArray(b.lines)) throw Error("Укажите полученное");
    for (const value of b.lines) {
      const l = find(d.lines, value.line, "Строка"),
        p = find(s.products, l.product, "Позиция"),
        target = integer(value.accepted),
        old = l.accepted || 0;
      if (target < old || target > l.quantity)
        throw Error("Проверьте принятое количество");
      const ids = value.serial_ids || [];
      if (p.kind === "phone") {
        if (
          !Array.isArray(ids) ||
          new Set(ids).size !== ids.length ||
          ids.some((i) => !l.serial_ids.includes(i))
        )
          throw Error("Телефон отсутствует в отправлении");
        const prev = l.accepted_ids || [];
        if (prev.some((i) => !ids.includes(i)) || ids.length !== target)
          throw Error("Количество должно соответствовать серийным номерам");
        for (const i of ids.filter((i) => !prev.includes(i))) {
          const item = find(s.units, i, "Экземпляр");
          if (item.status !== "transit" || item.transfer !== d.id)
            throw Error("Экземпляр уже изменён");
          Object.assign(item, { status: "available", shop: d.to });
          delete item.transfer;
        }
        l.accepted_ids = ids;
      } else {
        s.lots.push(
          ...sliceLots(
            l.lots || [{ quantity: l.quantity, buy: null }],
            old,
            target - old,
          ).map((lot) => ({ id: uid(), product: p.id, shop: d.to, ...lot })),
        );
        s.balances[p.id][d.to] += target - old;
      }
      l.accepted = target;
    }
    d.status = d.lines.every((l) => (l.accepted || 0) === l.quantity)
      ? "received"
      : "partial";
    d.received_by = u.name;
    audit(s, u, "Подтверждение приёмки перемещения", d);
    return d.id;
  }
  access(u, d.shop);
  if (a === "cancel") {
    if (d.status === "cancelled") return d.id;
    if (d.status !== "draft") throw Error("Отменять можно только черновики");
    d.status = "cancelled";
    audit(s, u, "Отмена черновика", d);
    return d.id;
  }
  if (
    a === "post" &&
    ["posted", "in_transit", "partial", "received"].includes(d.status)
  )
    return d.id;
  if (d.status !== "draft") throw Error("Документ уже проведён или отменён");
  if (a === "line") {
    const p = find(s.products, b.product, "Позиция");
    let original = null;
    if (d.type === "customer_return") {
      const sale = find(s.documents, d.sale, "Продажа");
      original = find(sale.lines, b.sale_line, "Строка продажи");
      if (original.product !== p.id)
        throw Error("Позиция отсутствует в продаже");
    }
    if ("buy" in b && !priv(u))
      throw new AccessError("Закупочная цена недоступна");
    if (d.lines.some((l) => l.product === p.id))
      throw Error("Позиция уже есть в документе");
    d.lines.push({
      id: uid(),
      product: p.id,
      name: p.name,
      barcode: p.barcode,
      quantity: p.kind === "phone" ? 0 : integer(b.quantity ?? 1, undefined, 1),
      serials: [],
      serial_ids: [],
      buy: price(b.buy === undefined ? p.buy : b.buy, true),
      sell: price(original ? original.sell : (b.sell ?? p.sell)),
      sale_line: original?.id ?? null,
    });
    return d.id;
  }
  if (a === "remove_line") {
    const l = find(d.lines, b.line, "Строка");
    d.lines.splice(d.lines.indexOf(l), 1);
    return d.id;
  }
  if (a === "scan") {
    if (d.type !== "receipt")
      throw Error("Сканирование поступления доступно в приёмке");
    const l = find(d.lines, b.line, "Строка"),
      p = find(s.products, l.product, "Позиция");
    if (p.kind !== "phone") throw Error("Для аксессуаров укажите количество");
    const value = serialCheck(s, b.serial, d.id);
    if (
      d.lines.some((l) =>
        l.serials.some((v) => normalize(v) === normalize(value)),
      )
    )
      throw Error("Этот номер уже есть в приёмке");
    l.serials.push(value);
    l.quantity = l.serials.length;
    return d.id;
  }
  if (a === "remove_scan") {
    const l = find(d.lines, b.line, "Строка"),
      index = l.serials.indexOf(b.serial);
    if (index < 0) throw Error("Номер не найден");
    l.serials.splice(index, 1);
    l.quantity = l.serials.length;
    return d.id;
  }
  if (a === "update_line") {
    const l = find(d.lines, b.line, "Строка"),
      p = find(s.products, l.product, "Позиция");
    if (p.kind === "phone") {
      if (d.type === "receipt")
        throw Error("Количество определяется сканированием");
      const ids = b.serial_ids || [];
      if (
        !Array.isArray(ids) ||
        ids.some((x) => typeof x !== "string") ||
        new Set(ids).size !== ids.length
      )
        throw Error("Проверьте номера");
      const selected = selectUnits(
        s,
        p,
        { serial_ids: ids },
        d.type === "customer_return" ? "sold" : "available",
        d.type === "customer_return" ? null : d.shop,
      );
      if (d.type === "customer_return") {
        const original = find(
          find(s.documents, d.sale, "Продажа").lines,
          l.sale_line,
          "Строка продажи",
        );
        if (
          selected.some(
            (item) =>
              item.sale !== d.sale || !original.serial_ids.includes(item.id),
          )
        )
          throw Error("Телефон не относится к исходной продаже");
      }
      l.serial_ids = ids;
      l.quantity = ids.length;
    } else l.quantity = integer(b.quantity, undefined, 1);
    if ("buy" in b) {
      if (!priv(u)) throw new AccessError("Закупочная цена недоступна");
      l.buy = price(b.buy, true);
    }
    if ("sell" in b && d.type === "sale") l.sell = price(b.sell);
    return d.id;
  }
  if (a !== "post") throw Error("Неизвестное действие");
  if (!d.lines.length || d.lines.some((l) => l.quantity <= 0))
    throw Error("Добавьте товары и заполните количество / серийники");
  if (["writeoff", "supplier_return"].includes(d.type) && !d.reason.trim())
    throw Error("Укажите причину");
  for (const l of d.lines) {
    const p = find(s.products, l.product, "Позиция"),
      q = integer(l.quantity, undefined, 1),
      kind = d.type;
    integer(q * l.sell, "Сумма строки слишком велика");
    if (l.buy !== null)
      integer(q * l.buy, "Себестоимость строки слишком велика");
    if (kind === "receipt") {
      if (p.kind === "phone") {
        if (l.serials.length !== q)
          throw Error("Количество не совпадает с номерами");
        for (const raw of l.serials) {
          const serial = serialCheck(s, raw, d.id);
          s.units.push({
            id: uid(),
            product: p.id,
            serial,
            shop: d.shop,
            status: "available",
            buy: l.buy,
          });
        }
      } else {
        s.balances[p.id][d.shop] += q;
        s.lots.push({
          id: uid(),
          product: p.id,
          shop: d.shop,
          quantity: q,
          buy: l.buy,
        });
      }
    } else if (kind === "customer_return") {
      const sale = find(s.documents, d.sale, "Продажа"),
        orig = find(sale.lines, l.sale_line, "Строка продажи"),
        returned = s.documents
          .filter(
            (x) =>
              x.type === "customer_return" &&
              x.status === "posted" &&
              x.sale === sale.id,
          )
          .flatMap((x) => x.lines)
          .filter((x) => x.sale_line === orig.id)
          .reduce((n, x) => n + x.quantity, 0);
      l.cost =
        p.kind === "phone"
          ? l.serial_ids.some((id) => orig.costs?.[id] == null)
            ? null
            : l.serial_ids.reduce((n, id) => n + orig.costs[id], 0)
          : orig.cost == null
            ? null
            : (orig.cost / orig.quantity) * q;
      if (returned + q > orig.quantity)
        throw Error("Количество превышает невозвращённый остаток продажи");
      if (p.kind === "phone") {
        const units = selectUnits(s, p, l, "sold");
        if (
          units.length !== q ||
          units.some(
            (x) => x.sale !== sale.id || !orig.serial_ids.includes(x.id),
          )
        )
          throw Error("Телефон не относится к продаже или уже возвращён");
        l.costs = Object.fromEntries(
          l.serial_ids.map((id) => [id, orig.costs?.[id] ?? null]),
        );
        for (const item of units) {
          Object.assign(item, { status: "available", shop: d.shop });
          delete item.sale;
        }
      } else {
        l.lots = sliceLots(
          orig.lots || [{ quantity: orig.quantity, buy: null }],
          returned,
          q,
        );
        l.cost = lotCost(l.lots);
        s.lots.push(
          ...l.lots.map((lot) => ({
            id: uid(),
            product: p.id,
            shop: d.shop,
            ...lot,
          })),
        );
        s.balances[p.id][d.shop] += q;
      }
    } else if (p.kind === "phone") {
      const units = selectUnits(s, p, l, "available", d.shop);
      if (units.length !== q) throw Error("Выберите номера всех телефонов");
      l.costs = Object.fromEntries(
        units.map((item) => [item.id, item.buy ?? null]),
      );
      l.cost = units.some((item) => item.buy == null)
        ? null
        : units.reduce((n, item) => n + item.buy, 0);
      for (const item of units) {
        if (kind === "transfer")
          Object.assign(item, {
            status: "transit",
            shop: null,
            transfer: d.id,
          });
        else if (kind === "sale")
          Object.assign(item, { status: "sold", sale: d.id });
        else
          item.status =
            kind === "supplier_return" ? "supplier_return" : "written_off";
      }
    } else {
      if (s.balances[p.id][d.shop] < q)
        throw Error("Недостаточный остаток: " + p.name);
      l.lots = takeLots(s, p.id, d.shop, q);
      l.cost = lotCost(l.lots);
      s.balances[p.id][d.shop] -= q;
    }
  }
  d.status = d.type === "transfer" ? "in_transit" : "posted";
  d.posted = now();
  d.posted_by = u.name;
  d.posted_by_id = u.id;
  audit(s, u, "Проведение документа", d);
  return d.id;
}

export function apply(s, b, u) {
  if (!b || typeof b !== "object" || Array.isArray(b))
    throw Error("Некорректный запрос");
  const existing = b.id ? s.documents.find((d) => d.id === b.id) : null;
  if (
    existing?.lines.length >= 500 &&
    ["line", "serial_add"].includes(b.action)
  )
    throw Error("Не более 500 строк в документе");
  const before = existing ? structuredClone(existing) : null;
  const result = applyAction(s, b, u);
  if (
    [
      "line",
      "remove_line",
      "scan",
      "remove_scan",
      "update_line",
      "serial_add",
    ].includes(b.action)
  ) {
    const d = find(s.documents, b.id, "Документ");
    const labels = {
      line: "Добавлена строка",
      remove_line: "Удалена строка",
      scan: "Добавлен серийный номер",
      remove_scan: "Удалён серийный номер",
      update_line: "Изменена строка",
      serial_add: "Добавлен телефон по серийному номеру",
    };
    audit(s, u, labels[b.action], d);
    const snapshot = (doc) =>
      doc?.lines.map((l) => ({
        id: l.id,
        quantity: l.quantity,
        buy: l.buy,
        sell: l.sell,
        serials: l.serials,
        serial_ids: l.serial_ids,
      })) ?? [];
    const changes = [];
    for (const id of new Set(
      [...snapshot(before), ...snapshot(d)].map((l) => l.id),
    )) {
      const prev = snapshot(before).find((l) => l.id === id),
        next = snapshot(d).find((l) => l.id === id);
      if (JSON.stringify(prev) === JSON.stringify(next)) continue;
      changes.push({
        line: id,
        before: prev
          ? { quantity: prev.quantity, buy: prev.buy, sell: prev.sell }
          : null,
        after: next
          ? { quantity: next.quantity, buy: next.buy, sell: next.sell }
          : null,
        added: [...(next?.serials || []), ...(next?.serial_ids || [])].filter(
          (v) =>
            ![...(prev?.serials || []), ...(prev?.serial_ids || [])].includes(
              v,
            ),
        ),
        removed: [...(prev?.serials || []), ...(prev?.serial_ids || [])].filter(
          (v) =>
            ![...(next?.serials || []), ...(next?.serial_ids || [])].includes(
              v,
            ),
        ),
      });
    }
    s.audit.at(-1).changes = changes;
  }
  return result;
}

const lotCost = (lots) =>
  lots.some((l) => l.buy == null)
    ? null
    : lots.reduce((n, l) => n + l.quantity * l.buy, 0);
function sliceLots(lots, skip, count) {
  const out = [];
  for (const lot of lots) {
    const offset = Math.min(skip, lot.quantity);
    skip -= offset;
    const quantity = Math.min(count, lot.quantity - offset);
    if (quantity > 0) {
      out.push({ quantity, buy: lot.buy });
      count -= quantity;
    }
    if (!count) break;
  }
  if (count) throw Error("Нарушена история партий");
  return out;
}
function takeLots(s, product, store, count) {
  s.lots ??= [];
  const lots = s.lots.filter(
    (l) => l.product === product && l.shop === store && l.quantity > 0,
  );
  const tracked = lots.reduce((n, l) => n + l.quantity, 0),
    missing = s.balances[product][store] - tracked;
  const out = [];
  if (missing > 0) {
    // Legacy stock predates all tracked lots. Keep its remainder implicit in
    // balances so the next transaction (including after SQLite reopen) still
    // consumes it first, independently of the persisted lots' row order.
    const quantity = Math.min(count, missing);
    out.push({ quantity, buy: null });
    count -= quantity;
  }
  for (const lot of lots) {
    const quantity = Math.min(count, lot.quantity);
    if (quantity > 0) {
      out.push({ quantity, buy: lot.buy });
      lot.quantity -= quantity;
      count -= quantity;
    }
    if (!count) break;
  }
  if (count) throw Error("Недостаточно товара в партиях");
  return out;
}
