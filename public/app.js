"use strict";
const $ = (id) => document.getElementById(id),
  esc = (s) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    ),
  money = (n) => (n === null ? "?" : (n / 100).toLocaleString("ru-RU") + " ₽"),
  fmt = (t) => new Date(t).toLocaleString("ru-RU");
let session = null,
  data = null,
  tab = "home",
  filter = -1,
  search = "",
  currentDoc = null,
  users = [],
  busy = false,
  scanPending = 0;
let selectedShop = -1;
let selectedDate = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Moscow",
}).format(new Date());
const scopeShop = () => (priv() ? selectedShop : session.user.shop);
const inShop = (d) =>
  scopeShop() < 0 ||
  d.shop === scopeShop() ||
  (d.type === "transfer" && d.to === scopeShop());
function selectShop(shop, nextTab = tab) {
  if (scanPending || busy) return toast("Дождитесь сохранения");
  if (!priv() && shop !== session.user.shop)
    return toast("Доступна только ваша точка");
  selectedShop = shop;
  filter = shop;
  tab = nextTab;
  currentDoc = null;
  render();
}
function selectDate(value) {
  selectedDate = value;
  render();
}
function reportURL() {
  const params = new URLSearchParams();
  if (scopeShop() >= 0) params.set("shop", scopeShop());
  if (selectedDate) params.set("date", selectedDate);
  return "/api/finance?" + params;
}
function periodPicker() {
  return `<div class="period-picker"><label>Дата (Москва)<input id="report-date" type="date" value="${esc(selectedDate)}" onchange="selectDate(this.value)"></label><button class="secondary" onclick="selectDate(new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow'}).format(new Date()))">Сегодня</button><button class="secondary" onclick="selectDate('')">Всё время</button></div>`;
}
const types = {
  receipt: "Приёмка",
  transfer: "Перемещение",
  sale: "Продажа",
  customer_return: "Возврат покупателя",
  supplier_return: "Возврат поставщику",
  writeoff: "Списание",
};
const statuses = {
  draft: "Черновик",
  posted: "Проведён",
  in_transit: "В пути",
  partial: "Частично принят",
  received: "Принят",
  cancelled: "Отменён",
};
const unitStatuses = {
  history: "В истории перемещения",
  available: "На складе",
  transit: "В пути",
  sold: "Продан",
  written_off: "Списан",
  supplier_return: "Возврат поставщику",
};
const roles = {
  admin: "Главный администратор",
  leader: "Руководитель",
  manager: "Менеджер",
};
const priv = () => session?.user.role !== "manager";
const canStore = (s) => priv() || session.user.shop === s;
const prod = (id) => data.products.find((p) => p.id === id);
const doc = (id) => data.documents.find((d) => d.id === id);
const unit = (id) => data.units.find((u) => u.id === id);
const total = (p) => p.quantities.reduce((s, q) => s + q, 0);
let toastTimer;
function toast(message) {
  $("toast").textContent = message;
  $("toast").className = "show";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").className = ""), 4000);
}
async function api(path, body) {
  const headers = body
    ? {
        "Content-Type": "application/json",
        "X-CSRF-Token": session?.csrf || "",
        "Idempotency-Key": crypto.randomUUID(),
      }
    : {};
  for (let attempt = 0; attempt < 2; attempt++) {
    let r;
    try {
      r = await fetch(path, {
        method: body ? "POST" : "GET",
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      if (!attempt) continue;
      throw Error(
        "Нет связи с сервером. Обновите данные перед повтором операции.",
      );
    }
    let d;
    try {
      d = await r.json();
    } catch {
      throw Error("Сервер не ответил. Проверьте состояние документа.");
    }
    if (!r.ok) {
      if (r.status === 503 && !attempt) continue;
      if (r.status === 401 && path !== "/api/login") {
        session = null;
        data = null;
        loginScreen();
      }
      throw Error(d.error || "Ошибка запроса");
    }
    return d;
  }
}
async function act(body, next) {
  if (busy) return;
  busy = true;
  document
    .querySelectorAll("[data-submit]")
    .forEach((b) => (b.disabled = true));
  try {
    const r = await api("/api/action", body);
    data = r.state;
    render();
    if (next) next(r.result);
    else toast("Сохранено");
  } catch (e) {
    toast(e.message);
  } finally {
    busy = false;
    document
      .querySelectorAll("[data-submit]")
      .forEach((b) => (b.disabled = false));
  }
}
function show(html, onSubmit) {
  if (scanPending) {
    toast("Дождитесь обработки сканирований");
    return;
  }
  if ($("dialog").open) $("dialog").close();
  $("form").innerHTML = html;
  const f = $("form").querySelector("form");
  if (f && onSubmit)
    f.onsubmit = (e) => {
      e.preventDefault();
      try {
        onSubmit(new FormData(f), f);
      } catch (error) {
        toast(error.message);
      }
    };
  $("dialog").showModal();
  setTimeout(
    () => $("form").querySelector("input:not([type=checkbox]),select")?.focus(),
    30,
  );
}
$("close-dialog").onclick = () => {
  if (scanPending || busy) return toast("Дождитесь сохранения");
  $("dialog").close();
};
$("dialog").addEventListener("cancel", (e) => {
  if (scanPending || busy) e.preventDefault();
});
function button(label, onclick, cls = "secondary") {
  return `<button class="${cls}" onclick="${onclick}">${label}</button>`;
}
function priceInput(n, label, value, unknown = false) {
  return `<label>${label}<input name="${n}" ${unknown ? 'inputmode="decimal"' : 'type="number" min="0" step="0.01" required'} value="${value === null ? "?" : value / 100}"></label>`;
}
function price(f, key, unknown = false) {
  const raw = String(f.get(key)).trim();
  if (unknown && (raw === "" || raw === "?")) return null;
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(raw))
    throw Error("Введите корректную цену");
  return Math.round(Number(raw.replace(",", ".")) * 100);
}
function storeOptions(selected, restrict = true) {
  return data.shops
    .map((s, i) =>
      !restrict || canStore(i)
        ? `<option value="${i}" ${selected === i ? "selected" : ""}>${esc(s)}</option>`
        : "",
    )
    .join("");
}
function loginScreen() {
  $("app").innerHTML =
    `<div class="login-wrap"><div class="login-card"><div class="brand"><span class="brand-icon">А</span><div>АлиДжон<span>STORE / СКЛАД</span></div></div><h1>Вход в склад</h1><p>Продажи, остатки и касса трёх магазинов.</p><form id="login-form"><label>Логин или email<input name="login" type="text" autocomplete="username" required maxlength="200"></label><label>Пароль<input name="password" type="password" autocomplete="current-password" required maxlength="200"></label><p id="login-error" role="alert" class="error" hidden></p><button class="primary full" type="submit">Войти →</button></form><p class="hint">Доступ выдаёт администратор склада.</p></div></div>`;
  $("login-form").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.currentTarget,
      button = f.querySelector("button");
    button.disabled = true;
    try {
      const values = new FormData(f);
      session = await api("/api/login", {
        login: values.get("login"),
        password: values.get("password"),
      });
      data = await api("/api/state");
      render();
    } catch (error) {
      $("login-error").hidden = false;
      $("login-error").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  };
}
async function logout() {
  if (scanPending || busy) return toast("Дождитесь сохранения");
  try {
    await api("/api/logout", {});
    session = null;
    data = null;
    currentDoc = null;
    tab = "home";
    selectedShop = -1;
    $("dialog").close();
    loginScreen();
  } catch (error) {
    toast(error.message);
  }
}
function changePassword() {
  show(
    `<h2>Изменить пароль</h2><form><label>Текущий пароль<input name="current" type="password" autocomplete="current-password" required></label><label>Новый пароль<input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="200" required></label><p>Не менее 12 символов. После изменения войдите снова.</p><button class="primary full" type="submit" data-submit>Изменить пароль</button></form>`,
    async (f) => {
      if (busy) return;
      busy = true;
      try {
        await api("/api/password", {
          current: f.get("current"),
          password: f.get("password"),
        });
        $("dialog").close();
        session = null;
        data = null;
        loginScreen();
        toast("Пароль изменён. Войдите снова");
      } catch (error) {
        toast(error.message);
      } finally {
        busy = false;
      }
    },
  );
}

function go(value) {
  if (scanPending) return toast("Дождитесь сохранения");
  tab = value;
  currentDoc = null;
  docFilter = "all";
  render();
}
function render() {
  if (!data) return;
  session.user = data.user;
  const nav = [
    ["home", "⌂", "Главная"],
    ["products", "▣", "Товары"],
    ["receipt", "↓", "Приёмка"],
    ["transfer", "⇄", "Перемещения"],
    ["sale", "↗", "Продажи"],
    ["operations", "⋯", "Другие операции"],
  ];
  nav.push(["finance", "₽", priv() ? "Финансы и касса" : "Касса"]);
  if (session.user.role === "admin")
    nav.push(["admin", "⚙", "Администрирование"]);
  const active = ["returns", "writeoff", "audit"].includes(tab)
    ? "operations"
    : tab === "users"
      ? "admin"
      : tab;
  $("app").innerHTML =
    `<div class="shell"><aside><div class="brand"><span class="brand-icon">А</span><div>АлиДжон<span>STORE / СКЛАД</span></div></div><div class="navlabel">РАБОТА С ТОВАРОМ</div>${nav.map(([v, icon, n]) => `<button class="nav ${active === v ? "active" : ""}" onclick="go('${v}')"><span class="nav-icon">${icon}</span>${n}${v === "transfer" && incoming().length ? '<span class="nav-count">' + incoming().length + "</span>" : ""}</button>`).join("")}<div class="navlabel locations">МАГАЗИНЫ</div>${data.shops.map((n, i) => (canStore(i) ? `<button class="nav ${scopeShop() === i ? "active" : ""}" onclick="selectShop(${i},'home')">Магазин ${i + 1} · ${esc(n)}<span>${data.products.reduce((s, p) => s + p.quantities[i], 0)}</span></button>` : "")).join("")}<div class="aside-bottom"><div class="user-name">${esc(session.user.name)}</div><small>${roles[session.user.role]}${session.user.shop !== null ? " · " + esc(data.shops[session.user.shop]) : ""}</small><button class="export" onclick="changePassword()">Изменить пароль</button><button class="export" onclick="logout()">Выйти из аккаунта</button></div></aside><main><header><span>АлиДжон Store <b>/ ${nav.find((x) => x[0] === active)?.[2] || "Склад"}</b></span><div class="header-actions"><button class="export" onclick="refresh()">↻ Обновить</button><span class="avatar">${esc(session.user.name[0])}</span></div></header><div class="mobile-nav">${nav.map(([v, _, n]) => button(n, `go('${v}')`, active === v ? "primary" : "secondary")).join("")}<button class="secondary" onclick="changePassword()">Пароль</button><button class="secondary" onclick="logout()">Выйти</button></div><div class="shop-scope"><label>Магазин<select id="shop-scope" onchange="selectShop(Number(this.value))">${priv() ? `<option value="-1" ${scopeShop() < 0 ? "selected" : ""}>Все магазины</option>` : ""}${data.shops.map((n, i) => (canStore(i) ? `<option value="${i}" ${scopeShop() === i ? "selected" : ""}>Магазин ${i + 1} · ${esc(n)}</option>` : "")).join("")}</select></label></div><section class="content" id="content"></section></main></div>`;
  if (tab === "home") home();
  else if (tab === "admin") adminHome();
  else if (tab === "operations") operationsHome();
  else if (tab === "finance") financeScreen();
  else if (tab === "products") products();
  else if (tab === "users") userList();
  else if (tab === "audit") auditScreen();
  else if (currentDoc) documentScreen(currentDoc);
  else documents();
}

async function refresh() {
  try {
    data = await api("/api/state");
    render();
    toast("Данные обновлены");
  } catch (e) {
    toast(e.message);
  }
}
function products() {
  filter = scopeShop();
  const count = data.products.reduce(
      (s, p) => s + (filter < 0 ? total(p) : p.quantities[filter]),
      0,
    ),
    transit =
      data.units.filter(
        (u) =>
          u.status === "transit" &&
          data.documents.some((d) => d.id === u.transfer && inShop(d)),
      ).length +
      data.documents
        .filter(
          (d) =>
            d.type === "transfer" &&
            inShop(d) &&
            ["in_transit", "partial"].includes(d.status),
        )
        .reduce(
          (s, d) =>
            s +
            d.lines
              .filter((l) => prod(l.product)?.kind === "other")
              .reduce((a, l) => a + l.quantity - (l.accepted || 0), 0),
          0,
        );
  $("content").innerHTML =
    `<div class="heading"><div><div class="eyebrow">КАТАЛОГ И ОСТАТКИ</div><h1>Товары на складе</h1><p>Позиции, экземпляры и движение между магазинами.</p></div>${priv() ? button("＋ Создать позицию", "editProduct()", "primary") : ""}</div><div class="catalog-summary"><span><b>${data.products.length}</b> позиций</span><span><b>${count}</b> единиц на складе</span><span><b>${transit}</b> единиц в пути</span></div><div class="panel"><div class="toolbar"><div class="tabs">${["Все магазины", ...data.shops].map((n, i) => ((i === 0 ? priv() : canStore(i - 1)) ? `<button class="${filter === i - 1 ? "selected" : ""}" onclick="selectShop(${i - 1},'products')">${esc(n)}</button>` : "")).join("")}</div>${button("↓ CSV", "exportCSV()", "export")}</div><div class="filters"><label class="search"><input id="search" value="${esc(search)}" placeholder="Название, штрих-код или серийный номер" oninput="search=this.value;productRows()"></label></div><div id="product-rows"></div></div><footer>Создание позиции не меняет остаток<span>Товар появляется после проведения приёмки</span></footer>`;
  productRows();
}
function productRows() {
  const q = search.toLowerCase(),
    rows = data.products.filter(
      (p) =>
        (filter < 0 || p.quantities[filter] > 0) &&
        [
          p.name,
          p.barcode,
          ...data.units.filter((u) => u.product === p.id).map((u) => u.serial),
        ]
          .join(" ")
          .toLowerCase()
          .includes(q),
    );
  $("product-rows").innerHTML = rows.length
    ? `<div class="table-wrap"><table><thead><tr><th>ПОЗИЦИЯ</th><th>ШТРИХ-КОД</th><th>ОСТАТОК</th>${priv() ? "<th>ЗАКУПКА / ШТ.</th>" : ""}<th>ПРОДАЖА / ШТ.</th><th></th></tr></thead><tbody>${rows.map((p) => `<tr><td><button class="item-title" onclick="productDetails('${p.id}')">${esc(p.name)}</button><small>${p.kind === "phone" ? "Телефон" : "Аксессуар"}</small></td><td class="codes">${esc(p.barcode)}</td><td><b>${filter < 0 ? total(p) : p.quantities[filter]} шт.</b><small>${p.quantities.map((n, i) => esc(data.shops[i]) + ": " + n).join(" · ")}</small></td>${priv() ? `<td>${money(p.buy)}</td>` : ""}<td>${money(p.sell)}</td><td>${button("Открыть", `productDetails('${p.id}')`)}</td></tr>`).join("")}</tbody></table></div>`
    : `<div class="empty"><h2>${data.products.length ? "Позиции не найдены" : "Создайте первую позицию"}</h2><p>После создания добавьте её в приёмку и внесите товары.</p>${priv() ? button("＋ Создать позицию", "editProduct()", "primary") : ""}</div>`;
}
function editProduct(id, returnDoc) {
  const p = prod(id) || {
    name: "",
    barcode: "",
    kind: "phone",
    buy: null,
    sell: 0,
  };
  show(
    `<h2>${id ? "Карточка позиции" : "Новая позиция"}</h2><p>Например: iPhone 16 · 128 ГБ · чёрный.</p><form><label>Наименование<input name="name" required maxlength="200" value="${esc(p.name)}"></label><label>Тип<select name="kind"><option value="phone" ${p.kind === "phone" ? "selected" : ""}>Телефон — серийные номера</option><option value="other" ${p.kind === "other" ? "selected" : ""}>Аксессуар — количество</option></select></label><label>Штрих-код<input name="barcode" required maxlength="100" value="${esc(p.barcode)}"></label><div class="grid2">${priv() ? priceInput("buy", "Закупка за штуку, ₽", p.buy, true) : ""}${priceInput("sell", "Продажа за штуку, ₽", p.sell)}</div>${priv() ? "<p>Неизвестная закупка — «?» или пустое поле.</p>" : ""}<p>Остаток появится после проведения приёмки.</p><button class="primary full" data-submit type="submit">Сохранить позицию</button></form>`,
    (f) => {
      try {
        const body = {
          id,
          name: f.get("name"),
          barcode: f.get("barcode"),
          kind: f.get("kind"),
          sell: price(f, "sell"),
        };
        if (priv()) body.buy = price(f, "buy", true);
        act({ action: "product", product: body }, (saved) => {
          $("dialog").close();
          toast("Позиция сохранена");
          if (returnDoc) addLine(returnDoc, saved);
          else productDetails(saved);
        });
      } catch (e) {
        toast(e.message);
      }
    },
  );
}
function productDetails(id) {
  const p = prod(id),
    units = data.units.filter((u) => u.product === id),
    docs = data.documents.filter((d) => d.lines.some((l) => l.product === id));
  show(
    `<h2>${esc(p.name)}</h2><p>${esc(p.barcode)} · ${p.kind === "phone" ? "Телефон" : "Аксессуар"}</p><div class="card-actions">${priv() ? button("Изменить карточку", `editProduct('${id}')`) : ""}${button("Создать приёмку", `$('dialog').close();newDocument('receipt','${id}')`, "primary")}</div><div class="balance-cards">${data.shops.map((n, i) => `<div><small>${esc(n)}</small><b>${p.quantities[i]} шт.</b></div>`).join("")}</div>${units.length ? `<h3>Экземпляры и серийные номера</h3><div class="serial-list">${units.map((u) => `<div class="serial-row"><code>${esc(u.serial)}</code><span>${unitStatuses[u.status]}${u.shop !== null ? " · " + esc(data.shops[u.shop]) : ""}</span></div>`).join("")}</div>` : ""}${p.kind === "phone" ? data.shops.map((name, i) => (data.balances[id][i] > 0 && canStore(i) ? `<div class="notice">${esc(name)}: ${data.balances[id][i]} телефонов из прежней базы без серийников. ${button("Указать номера", `attachLegacy('${id}',${i})`)}</div>` : "")).join("") : ""}<h3>Документы по позиции</h3>${
      docs.length
        ? docs
            .slice()
            .reverse()
            .map(
              (d) =>
                `<button class="doc-link" onclick="$('dialog').close();openDoc('${d.id}')">${types[d.type]} №${d.number} <span>${statuses[d.status]} · ${fmt(d.created)}</span></button>`,
            )
            .join("")
        : "<p>Операций пока нет.</p>"
    }`,
  );
}
let docFilter = "all";
function documents() {
  const all = data.documents
      .filter(inShop)
      .filter((d) =>
        tab === "returns"
          ? ["customer_return", "supplier_return"].includes(d.type)
          : d.type === tab,
      )
      .slice()
      .reverse(),
    rows = all.filter(
      (d) =>
        docFilter === "all" ||
        (docFilter === "draft"
          ? d.status === "draft"
          : docFilter === "pending"
            ? ["in_transit", "partial"].includes(d.status)
            : ["posted", "received"].includes(d.status)),
    );
  const kind = tab === "returns" ? "customer_return" : tab;
  $("content").innerHTML =
    `<div class="heading"><div><div class="eyebrow">ДОКУМЕНТЫ</div><h1>${{ receipt: "Приёмка товара", transfer: "Перемещения", sale: "Продажи", returns: "Возвраты", writeoff: "Списания" }[tab]}</h1><p>${tab === "transfer" ? "Отправьте из одного магазина. Подтвердите получение в другом." : "Добавьте товары, проверьте данные и подтвердите операцию."}</p></div>${button({ receipt: "＋ Новая приёмка", transfer: "＋ Переместить товар", sale: "＋ Новая продажа", returns: "＋ Возврат покупателя", writeoff: "＋ Новое списание" }[tab], `newDocument('${kind}')`, "primary")}</div>${tab === "returns" ? '<div class="document-actions">' + button("Возврат поставщику", "newDocument('supplier_return')") + "</div>" : ""}<div class="panel doc-panel"><div class="toolbar"><div class="tabs">${[["all", "Все"], ["draft", "Черновики"], ...(tab === "transfer" ? [["pending", "Ждут приёмки"]] : []), ["done", "Завершённые"]].map(([k, n]) => `<button class="${docFilter === k ? "selected" : ""}" onclick="docFilter='${k}';documents()">${n} <small>${all.filter((d) => k === "all" || (k === "draft" ? d.status === "draft" : k === "pending" ? ["in_transit", "partial"].includes(d.status) : ["posted", "received"].includes(d.status))).length}</small></button>`).join("")}</div></div>${rows.length ? rows.map((d) => docRow(d)).join("") : '<div class="empty"><div class="empty-symbol">' + (all.length ? "⌕" : "▤") + "</div><h2>" + (all.length ? "Здесь пока нет документов" : "Начните с первого документа") + "</h2><p>" + (all.length ? "Выберите другой статус." : "Создайте документ и добавьте товарные позиции.") + "</p></div>"}</div>`;
}

function newDocument(kind, presetProduct) {
  const sales = data.documents.filter(
    (d) =>
      d.type === "sale" &&
      d.status === "posted" &&
      canStore(d.shop) &&
      inShop(d),
  );
  show(
    `<h2>${types[kind]}</h2><form><label>${kind === "transfer" ? "Откуда" : "Магазин"}<select name="shop">${storeOptions(scopeShop() >= 0 ? scopeShop() : 0)}</select></label>${kind === "transfer" ? `<label>Куда<select name="to">${storeOptions(((scopeShop() >= 0 ? scopeShop() : 0) + 1) % 3, false)}</select></label>` : ""}${kind === "sale" ? '<label>Оплата<select name="payment"><option value="cash">Наличные</option><option value="card">Карта / безналичные</option></select></label>' : ""}${kind === "customer_return" ? `<label>Исходная продажа<select name="sale" required><option value="">Выберите продажу</option>${sales.map((d) => `<option value="${d.id}">№${d.number} · ${esc(data.shops[d.shop])} · ${fmt(d.created)}</option>`).join("")}</select></label>` : ""}${["writeoff", "supplier_return"].includes(kind) ? '<label>Причина<textarea name="reason" required maxlength="1000" rows="3"></textarea></label>' : ""}<button class="primary full" data-submit type="submit">Создать черновик</button></form>`,
    (f) =>
      act(
        {
          action: "create",
          type: kind,
          shop: Number(f.get("shop")),
          to: f.has("to") ? Number(f.get("to")) : null,
          sale: f.get("sale"),
          reason: f.get("reason") || "",
          payment: f.get("payment"),
        },
        (id) => {
          $("dialog").close();
          openDoc(id);
          if (presetProduct) addLine(id, presetProduct);
        },
      ),
  );
}
function openDoc(id) {
  const d = doc(id);
  tab = ["customer_return", "supplier_return"].includes(d.type)
    ? "returns"
    : d.type;
  currentDoc = id;
  render();
}
function documentScreen(id) {
  const d = doc(id),
    editable = d.status === "draft" && canStore(d.shop),
    receivable =
      d.type === "transfer" &&
      ["in_transit", "partial"].includes(d.status) &&
      canStore(d.to);
  $("content").innerHTML =
    `<div class="heading"><div><button class="export" onclick="currentDoc=null;render()">← К списку</button><h1>${types[d.type]} №${d.number}</h1><p>${esc(data.shops[d.shop])}${d.to !== null ? " → " + esc(data.shops[d.to]) : ""} · ${esc(d.actor)} · ${fmt(d.created)}</p></div><span class="status ${d.status}">${statuses[d.status]}</span></div><div class="document-actions">${editable ? button("＋ Добавить позицию", `addLine('${id}')`, "primary") + button(d.type === "transfer" ? "Отправить товар" : "Провести документ", `postDocument('${id}')`, "primary") + button("Отменить черновик", `cancelDoc('${id}')`) : ""}${receivable ? button("Подтвердить получение", `receive('${id}')`, "primary") : ""}</div>${editable && ["sale", "writeoff", "supplier_return", "transfer"].includes(d.type) ? `<form id="outgoing-serial" class="serial-entry panel"><label>Серийный номер телефона<input name="serial" id="outgoing-serial-input" maxlength="100" required autocomplete="off" placeholder="Введите серийный номер и нажмите Enter"></label><button type="submit" class="primary" data-submit>Добавить по номеру</button><p class="hint">Телефон должен быть на складе выбранной точки. Аксессуары добавляются кнопкой «Добавить позицию».</p></form>` : ""}${d.type === "receipt" && editable ? '<div class="notice">Добавьте позицию → сканируйте её серийные номера → переходите к следующей позиции. На склад товар попадёт после проведения приёмки.</div>' : ""}${d.reason ? `<div class="notice">Причина: ${esc(d.reason)}</div>` : ""}<div class="panel">${
      d.lines.length
        ? d.lines
            .map((l) => {
              const p = prod(l.product);
              return `<div class="document-line"><div class="line-head"><div><h3>${esc(l.name || p.name)}</h3><small>${esc(l.barcode || p.barcode)} · ${l.quantity} шт.${d.type === "transfer" ? " · Принято: " + (l.accepted || 0) : ""}</small></div><div class="card-actions">${editable ? (d.type === "receipt" && p.kind === "phone" ? button("Сканировать серийники", `scanReceipt('${id}','${l.id}')`, "primary") : button(p.kind === "phone" ? "Выбрать / сканировать телефоны" : "Изменить количество", `editLine('${id}','${l.id}')`)) + button("Убрать строку", `removeLine('${id}','${l.id}')`) : ""}</div></div><p>${priv() ? "Закупка: " + money(l.buy) + " / шт. · " : ""}Продажа: ${money(l.sell)} / шт.</p>${p.kind === "phone" ? `<div class="tags">${(d.type === "receipt" ? l.serials : l.serial_ids.map((i) => unit(i)?.serial || i)).map((v) => `<span>${esc(v)}</span>`).join("") || "<small>Серийные номера ещё не выбраны</small>"}</div>` : ""}</div>`;
            })
            .join("")
        : '<div class="empty"><h2>Добавьте первую позицию</h2><p>Выберите товар из каталога.</p></div>'
    }</div>${d.type === "sale" ? `<div class="sale-total">Итого: ${money(d.lines.reduce((s, l) => s + l.quantity * l.sell, 0))}</div>` : ""}`;
  const serialForm = $("outgoing-serial");
  if (serialForm)
    serialForm.onsubmit = (e) => {
      e.preventDefault();
      const serial = new FormData(serialForm).get("serial");
      act({ action: "serial_add", id, serial }, () => {
        toast("Телефон добавлен");
        $("outgoing-serial-input")?.focus();
      });
    };
}
function catalogMatches(products, query) {
  const q = String(query || "")
    .trim()
    .toLowerCase();
  if (!q) return products;
  return products
    .filter(
      (p) =>
        p.barcode.toLowerCase() === q ||
        p.name.toLowerCase().includes(q) ||
        p.barcode.toLowerCase().includes(q),
    )
    .sort(
      (a, b) =>
        Number(b.barcode.toLowerCase() === q) -
        Number(a.barcode.toLowerCase() === q),
    );
}
function addLine(id, presetProduct) {
  const d = doc(id);
  if (d.type !== "receipt") return addLineClassic(id, presetProduct);
  show(
    `<h2>Добавить товар в приёмку</h2><p>Отсканируйте штрих-код или найдите позицию по названию.</p><form autocomplete="off"><label>Поиск товара<input id="receipt-product-search" name="query" autocomplete="off" spellcheck="false" placeholder="Название или штрих-код + Enter"></label><p class="hint">Сканер должен отправлять Enter после кода. Для телефона сразу откроется ввод серийного номера.</p><button type="submit" class="primary full" data-submit>Найти по штрих-коду</button></form><p id="receipt-search-status" class="hint" role="status" aria-live="polite"></p><div id="receipt-product-results" class="product-search-results"></div><div class="picker-action">${priv() ? button("＋ Создать новую позицию", `editProduct(undefined,'${id}')`) : ""}</div>`,
    () => submitSearch(),
  );
  const input = $("receipt-product-search"),
    results = $("receipt-product-results"),
    status = $("receipt-search-status");
  function choose(productId) {
    if (busy) return;
    const current = doc(id);
    if (current.status !== "draft") return toast("Приёмка уже проведена");
    const existing = current.lines.find((l) => l.product === productId);
    const open = () => {
      const line = doc(id).lines.find((l) => l.product === productId);
      if (prod(productId).kind === "phone") scanReceipt(id, line.id);
      else editLine(id, line.id);
    };
    if (existing) {
      open();
      return;
    }
    act({ action: "line", id, product: productId, quantity: 1 }, open);
  }
  function update() {
    const matches = catalogMatches(data.products, input.value);
    status.textContent = matches.length
      ? "Найдено позиций: " + matches.length
      : "Товар не найден. Проверьте код или создайте новую позицию.";
    results.innerHTML = matches
      .map((p) => {
        const existing = doc(id).lines.some((l) => l.product === p.id);
        return `<button type="button" class="product-search-row" data-product="${p.id}" data-submit><span class="product-search-icon">${p.kind === "phone" ? "▯" : "▣"}</span><span><b>${esc(p.name)}</b><small>${esc(p.barcode)} · ${p.kind === "phone" ? "Телефон" : "Аксессуар"}${existing ? " · Уже в приёмке" : ""}</small></span><span class="product-search-next">${p.kind === "phone" ? "К серийникам" : "Количество"} →</span></button>`;
      })
      .join("");
    results
      .querySelectorAll("[data-product]")
      .forEach(
        (button) => (button.onclick = () => choose(button.dataset.product)),
      );
  }
  function submitSearch() {
    const q = input.value.trim().toLowerCase();
    if (!q) {
      status.textContent = "Отсканируйте штрих-код или введите название.";
      input.focus();
      return;
    }
    const exact = data.products.filter((p) => p.barcode.toLowerCase() === q);
    const matches = exact.length ? exact : catalogMatches(data.products, q);
    if (matches.length === 1) {
      choose(matches[0].id);
      return;
    }
    update();
    status.textContent = matches.length
      ? "По этому запросу несколько позиций. Выберите нужную ниже."
      : "Товар с таким кодом не найден. Проверьте код или создайте позицию.";
  }
  input.oninput = update;
  if (presetProduct) {
    const p = prod(presetProduct);
    if (p) input.value = p.barcode;
  }
  update();
}
function addLineClassic(id, presetProduct) {
  const d = doc(id),
    sale = d.type === "customer_return" ? doc(d.sale) : null,
    options = sale
      ? sale.lines.map((l) => ({ p: prod(l.product), saleLine: l.id }))
      : data.products.map((p) => ({ p }));
  show(
    `<h2>Добавить товар</h2><p>Выберите позицию из каталога. Для нового товара сначала создайте карточку.</p><div class="picker-action">${priv() ? button("＋ Создать новую позицию", `editProduct(undefined,'${id}')`) : ""}</div><form><label>Позиция<select name="product" required>${options
      .filter((x) => !d.lines.some((l) => l.product === x.p.id))
      .map(
        (x) =>
          `<option value="${x.p.id}" ${x.p.id === presetProduct ? "selected" : ""} data-sale-line="${x.saleLine || ""}">${esc(x.p.name)} · ${esc(x.p.barcode)}</option>`,
      )
      .join(
        "",
      )}</select></label><p>Телефоны добавляются сканированием или выбором экземпляров. Количество аксессуаров можно изменить в строке.</p><button class="primary full" data-submit type="submit">Добавить</button></form>`,
    (f, form) => {
      const option = form.querySelector("select").selectedOptions[0];
      if (!option) return toast("Все позиции уже добавлены или каталог пуст");
      act(
        {
          action: "line",
          id,
          product: f.get("product"),
          quantity: 1,
          sale_line: option.dataset.saleLine || null,
        },
        () => {
          $("dialog").close();
          const updated = doc(id),
            l = updated.lines.find((l) => l.product === f.get("product"));
          if (prod(l.product).kind === "phone" && updated.type === "receipt")
            scanReceipt(id, l.id);
          else editLine(id, l.id);
        },
      );
    },
  );
}
function lineUnits(d, l) {
  if (d.type === "customer_return") {
    const original = doc(d.sale).lines.find((x) => x.id === l.sale_line);
    return original.serial_ids
      .map(unit)
      .filter((u) => u.status === "sold" && u.sale === d.sale);
  }
  return data.units.filter(
    (u) =>
      u.product === l.product && u.shop === d.shop && u.status === "available",
  );
}
function editLine(id, lineId) {
  const d = doc(id),
    l = d.lines.find((x) => x.id === lineId),
    p = prod(l.product),
    phone = p.kind === "phone",
    units = phone ? lineUnits(d, l) : [];
  show(
    `<h2>${esc(p.name)}</h2><form>${
      phone
        ? `<label>Сканировать для выбора<input id="select-scan" autocomplete="off" placeholder="Серийный номер + Enter"></label><p class="hint">Отметьте телефоны. Выбрано: <b id="selection-count">${l.serial_ids.length}</b></p><div class="serial-choices">${
            units
              .filter(
                (u) =>
                  !["sale", "writeoff", "supplier_return"].includes(d.type) ||
                  l.serial_ids.includes(u.id),
              )
              .map(
                (u) =>
                  `<label><input type="checkbox" name="ids" value="${u.id}" ${l.serial_ids.includes(u.id) ? "checked" : ""}>${esc(u.serial)}</label>`,
              )
              .join("") || "<p>Доступных экземпляров нет.</p>"
          }</div>`
        : `<label>Количество<input name="quantity" type="number" min="1" step="1" required value="${l.quantity}"></label>`
    }<div class="grid2">${priv() ? priceInput("buy", "Закупка за штуку, ₽", l.buy, true) : ""}${d.type === "sale" ? priceInput("sell", "Фактическая цена продажи, ₽", l.sell) : ""}</div><button class="primary full" data-submit type="submit">Сохранить строку</button></form>`,
    (f) => {
      try {
        const b = { action: "update_line", id, line: lineId };
        if (phone) b.serial_ids = f.getAll("ids");
        else b.quantity = Number(f.get("quantity"));
        if (priv()) b.buy = price(f, "buy", true);
        if (d.type === "sale") b.sell = price(f, "sell");
        act(b, () => {
          $("dialog").close();
        });
      } catch (e) {
        toast(e.message);
      }
    },
  );
  if (phone) {
    const f = $("form").querySelector("form");
    f.onchange = () =>
      ($("selection-count").textContent =
        f.querySelectorAll("[name=ids]:checked").length);
    $("select-scan").onkeydown = (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const value = e.target.value.trim().toLowerCase(),
        u = units.find((u) => u.serial.toLowerCase() === value);
      if (!u)
        return toast(
          "Этот телефон недоступен в выбранном магазине или продаже",
        );
      let input = f.querySelector(`[value="${u.id}"]`);
      if (!input) {
        const label = document.createElement("label");
        input = document.createElement("input");
        input.type = "checkbox";
        input.name = "ids";
        input.value = u.id;
        label.append(input, document.createTextNode(u.serial));
        f.querySelector(".serial-choices").append(label);
      }
      if (input.checked) toast("Этот телефон уже выбран");
      else {
        input.checked = true;
        f.onchange();
        toast("Телефон выбран");
      }
      e.target.value = "";
    };
  }
}
function removeLine(id, line) {
  if (confirm("Убрать позицию из черновика?"))
    act({ action: "remove_line", id, line });
}
function cancelDoc(id) {
  if (confirm("Отменить этот черновик? Остатки не изменятся."))
    act({ action: "cancel", id });
}
function postDocument(id) {
  const d = doc(id);
  if (
    confirm(
      d.type === "transfer"
        ? "Отправить товар? Он перейдёт в статус «В пути»."
        : "Провести документ и изменить остатки?",
    )
  )
    act({ action: "post", id });
}
function scanReceipt(id, lineId) {
  const d = doc(id),
    l = d.lines.find((x) => x.id === lineId),
    p = prod(l.product);
  let queue = [],
    running = false;
  show(
    `<h2>${esc(p.name)}</h2><p>Приёмка №${d.number} · ${esc(data.shops[d.shop])}</p><form autocomplete="off"><label>Серийный номер<input name="serial" id="receipt-scan" required maxlength="100" autocomplete="off" spellcheck="false" placeholder="Сканируйте серийник + Enter"></label><button class="primary full" type="submit">Добавить в приёмку +1</button></form><p class="hint">Каждый новый номер увеличивает количество в этой строке приёмки. Складской остаток изменится после проведения всего документа.</p><p id="scan-count" aria-live="polite">В позиции: ${l.quantity} шт.</p><div id="scan-log" role="status" aria-live="polite"></div><div id="scan-existing" class="tags"></div><div class="card-actions" style="margin-top:20px"><button id="scan-next" class="primary">Следующая позиция →</button><button id="scan-done" class="secondary">К документу</button></div>`,
    (f) => {
      const value = String(f.get("serial")).trim();
      if (!value) return;
      queue.push(value);
      scanPending++;
      input.value = "";
      input.focus();
      pump();
    },
  );
  const input = $("receipt-scan"),
    count = $("scan-count"),
    log = $("scan-log"),
    next = $("scan-next"),
    done = $("scan-done"),
    existing = $("scan-existing");
  function existingTags() {
    const line = doc(id).lines.find((x) => x.id === lineId);
    existing.innerHTML = line.serials
      .map(
        (v) =>
          `<span>${esc(v)} <button class="tag-remove" data-serial="${esc(v)}" title="Убрать ошибочно введённый номер">×</button></span>`,
      )
      .join("");
    existing.querySelectorAll("button").forEach(
      (b) =>
        (b.onclick = () => {
          if (scanPending) return toast("Дождитесь сохранения");
          act(
            {
              action: "remove_scan",
              id,
              line: lineId,
              serial: b.dataset.serial,
            },
            () => {
              existingTags();
              count.textContent =
                "В позиции: " +
                doc(id).lines.find((x) => x.id === lineId).quantity +
                " шт.";
            },
          );
        }),
    );
  }
  existingTags();
  next.onclick = () => {
    if (scanPending) return toast("Дождитесь сохранения");
    addLine(id);
  };
  done.onclick = () => {
    if (scanPending) return toast("Дождитесь сохранения");
    $("dialog").close();
  };
  async function pump() {
    if (running) return;
    running = true;
    next.disabled = done.disabled = true;
    while (queue.length) {
      const value = queue.shift();
      count.textContent =
        "Сохраняем " + value + " · В очереди: " + queue.length;
      const line = document.createElement("p");
      try {
        const r = await api("/api/action", {
          action: "scan",
          id,
          line: lineId,
          serial: value,
        });
        data = r.state;
        render();
        line.textContent = "✓ " + value + " — добавлен в приёмку";
        line.style.color = "#187d65";
        existingTags();
      } catch (e) {
        line.textContent =
          "✕ " +
          value +
          " — " +
          e.message +
          " При сбое связи повторите сканирование: дубль не добавится.";
        line.style.color = "#b14d3d";
      } finally {
        scanPending--;
      }
      log.prepend(line);
      if (log.children.length > 20) log.lastElementChild.remove();
    }
    count.textContent =
      "В позиции: " +
      doc(id).lines.find((x) => x.id === lineId).quantity +
      " шт.";
    next.disabled = done.disabled = false;
    running = false;
  }
}
function receive(id) {
  const d = doc(id);
  show(
    `<h2>Принять перемещение №${d.number}</h2><p>${esc(data.shops[d.shop])} → ${esc(data.shops[d.to])}</p><form><label>Серийный номер полученного телефона<input id="receive-scan" autocomplete="off" placeholder="Сканируйте номер + Enter"></label>${d.lines
      .map((l) => {
        const p = prod(l.product);
        return `<section class="stock-section" data-line="${l.id}"><h3>${esc(p.name)}</h3><p>Отправлено ${l.quantity} шт. · Ранее принято ${l.accepted || 0}</p>${p.kind === "phone" ? `<div class="serial-choices">${l.serial_ids.map((i) => `<label><input type="checkbox" name="units" value="${i}" ${(l.accepted_ids || []).includes(i) ? "checked disabled" : ""}>${esc(unit(i).serial)}</label>`).join("")}</div>` : `<label>Всего принято с учётом предыдущих приёмок<input name="accepted" type="number" min="${l.accepted || 0}" max="${l.quantity}" step="1" required value="${l.accepted || 0}"></label>`}</section>`;
      })
      .join(
        "",
      )}<p>Подтвердите только фактически полученное. Остаток отправления останется в пути.</p><button data-submit type="submit" class="primary full">Подтвердить приёмку</button></form>`,
    (_, form) => {
      const lines = d.lines.map((l) => {
        const section = form.querySelector(`[data-line="${l.id}"]`);
        if (prod(l.product).kind === "phone") {
          const ids = [...section.querySelectorAll("[name=units]:checked")].map(
            (x) => x.value,
          );
          return { line: l.id, accepted: ids.length, serial_ids: ids };
        }
        return {
          line: l.id,
          accepted: Number(section.querySelector("[name=accepted]").value),
        };
      });
      act({ action: "accept", id, lines }, () => {
        $("dialog").close();
        toast("Фактическое получение подтверждено");
      });
    },
  );
  const input = $("receive-scan");
  input.onkeydown = (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const value = input.value.trim().toLowerCase(),
      u = data.units.find((u) => u.serial.toLowerCase() === value);
    const checkbox = u && $("form").querySelector(`[value="${u.id}"]`);
    if (!checkbox) return toast("Телефон отсутствует в этом перемещении");
    if (checkbox.checked) toast("Этот телефон уже отмечен");
    else {
      checkbox.checked = true;
      toast("Получение телефона отмечено");
    }
    input.value = "";
  };
}
async function userList() {
  try {
    users = await api("/api/users");
    if (tab !== "users") return;
    $("content").innerHTML =
      `<div class="heading"><div><div class="eyebrow">ЛИЧНЫЕ ДОСТУПЫ</div><h1>Сотрудники</h1><p>Каждая операция связана с личной учётной записью сотрудника.</p></div>${button("＋ Добавить сотрудника", "editUser()", "primary")}</div><div class="panel" style="margin-top:25px">${users.map((u) => `<button class="doc-link" onclick="editUser('${u.id}')"><div><b>${esc(u.name)}</b><span>${esc(u.login)} · ${roles[u.role]}${u.shop !== null ? " · " + esc(data.shops[u.shop]) : ""}</span></div><span class="status">${u.active ? "Активен" : "Отключён"}</span></button>`).join("")}</div>`;
  } catch (e) {
    toast(e.message);
  }
}
function editUser(id) {
  const u = users.find((x) => x.id === id) || {
    login: "",
    name: "",
    role: "manager",
    shop: 0,
    active: 1,
  };
  show(
    `<h2>${id ? "Доступ сотрудника" : "Новый сотрудник"}</h2><form><label>Имя<input name="name" required maxlength="100" value="${esc(u.name)}"></label><label>Логин или email<input name="login" type="text" required maxlength="200" value="${esc(u.login)}" autocomplete="off"></label><label>Пароль${id ? " (оставьте пустым, чтобы сохранить)" : ""}<input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="200" ${id ? "" : "required"}></label><label>Роль<select name="role">${Object.entries(
      roles,
    )
      .map(
        ([k, v]) =>
          `<option value="${k}" ${u.role === k ? "selected" : ""}>${v}</option>`,
      )
      .join(
        "",
      )}</select></label><label>Магазин менеджера<select name="shop">${storeOptions(u.shop ?? 0, false)}</select></label><label class="check"><input name="active" type="checkbox" ${u.active ? "checked" : ""}>Доступ активен</label><p>Сотрудник входит по этому логину и паролю. Менеджер работает только со своей точкой; закупочные цены и прибыль скрыты, касса доступна только своей точки.</p><button class="primary full" data-submit type="submit">Сохранить доступ</button></form>`,
    async (f) => {
      if (busy) return;
      busy = true;
      try {
        await api("/api/users", {
          id,
          login: f.get("login"),
          name: f.get("name"),
          role: f.get("role"),
          shop: Number(f.get("shop")),
          active: f.has("active"),
          password: f.get("password") || undefined,
        });
        $("dialog").close();
        await refresh();
        toast("Доступ сохранён");
      } catch (e) {
        toast(e.message);
      } finally {
        busy = false;
      }
    },
  );
}
function auditScreen() {
  $("content").innerHTML =
    `<div class="heading"><div><div class="eyebrow">КОНТРОЛЬ ОПЕРАЦИЙ</div><h1>История действий</h1><p>Кто, когда и какой документ оформил.</p></div></div><div class="panel" style="margin-top:25px">${
      data.audit
        .slice()
        .reverse()
        .map(
          (a) =>
            `<div class="event"><div><b>${esc(a.action)}</b><p>${esc(a.actor)}${a.document ? " · " + types[doc(a.document)?.type] + " №" + doc(a.document)?.number : ""}</p></div><time>${fmt(a.at)}</time>${a.document ? button("Открыть", `openDoc('${a.document}')`) : ""}</div>`,
        )
        .join("") || '<div class="empty">История пока пуста</div>'
    }</div>`;
}
function exportCSV() {
  const rows = [
    [
      "Позиция",
      "Штрих-код",
      "Магазин",
      "Количество",
      ...(priv() ? ["Закупка за штуку"] : []),
      "Продажа за штуку",
    ],
    ...data.products.flatMap((p) =>
      data.shops.map((n, i) => [
        p.name,
        p.barcode,
        n,
        p.quantities[i],
        ...(priv() ? [p.buy === null ? "?" : p.buy / 100] : []),
        p.sell / 100,
      ]),
    ),
  ];
  const csv =
      "\uFEFF" +
      rows
        .map((r) =>
          r
            .map((v) => {
              let str = String(v);
              if (/^[=+@\-]/.test(str)) str = "'" + str;
              return '"' + str.replace(/"/g, '""') + '"';
            })
            .join(";"),
        )
        .join("\r\n"),
    url = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
    ),
    a = document.createElement("a");
  a.href = url;
  a.download = "АлиДжон-остатки.csv";
  a.click();
  URL.revokeObjectURL(url);
}
(async () => {
  try {
    session = await api("/api/session");
    if (session.user) {
      data = await api("/api/state");
      render();
    } else loginScreen(session.needs_setup);
  } catch (e) {
    $("app").innerHTML =
      '<div class="empty"><h2>Не удалось подключиться к базе</h2><p>' +
      esc(e.message) +
      '</p><button class="primary" onclick="location.reload()">Повторить</button></div>';
  }
})();

function attachLegacy(id, store) {
  const p = prod(id);
  show(
    `<h2>Уточнить прежний остаток</h2><p>${esc(p.name)} · ${esc(data.shops[store])}</p><form><label>Серийные номера, по одному на строку<textarea name="serials" rows="6" required></textarea></label><p>Не больше ${data.balances[id][store]} номеров. Общее количество не увеличится: номера относятся к уже учтённым телефонам.</p><button class="primary full" data-submit type="submit">Сохранить номера</button></form>`,
    (f) =>
      act(
        {
          action: "attach_legacy",
          product: id,
          shop: store,
          serials: f
            .get("serials")
            .split(/\r?\n/)
            .map((x) => x.trim())
            .filter(Boolean),
        },
        () => productDetails(id),
      ),
  );
}
function incoming() {
  return data.documents.filter(
    (d) =>
      d.type === "transfer" &&
      ["in_transit", "partial"].includes(d.status) &&
      canStore(d.to) &&
      (scopeShop() < 0 || d.to === scopeShop()),
  );
}
function docRow(d) {
  return `<button class="doc-link" onclick="openDoc('${d.id}')"><div class="doc-main"><span class="doc-kind-icon">${{ receipt: "↓", transfer: "⇄", sale: "↗", customer_return: "↩", supplier_return: "↩", writeoff: "−" }[d.type]}</span><div><b>${types[d.type]} №${d.number}</b><span>${esc(data.shops[d.shop])}${d.to !== null ? " → " + esc(data.shops[d.to]) : ""} · ${d.lines.reduce((s, l) => s + l.quantity, 0)} шт.</span></div></div><div class="doc-right"><span class="status ${d.status}">${statuses[d.status]}</span><small>${fmt(d.created)}</small></div></button>`;
}
let screenRequest = 0;
async function home() {
  const root = $("content"),
    request = ++screenRequest;
  root.innerHTML = '<div class="small-empty">Загружаем магазины…</div>';
  try {
    const report = await api(reportURL());
    if (tab !== "home" || root !== $("content") || request !== screenRequest)
      return;
    const shop = scopeShop(),
      pending = incoming(),
      scopedDocs = data.documents.filter(inShop);
    const title =
      shop < 0 ? "Рабочий стол" : `Магазин ${shop + 1} · ${data.shops[shop]}`;
    const summary = report.shops.reduce(
      (n, s) => ({
        revenue: n.revenue + s.netRevenue,
        cash: n.cash + s.cash,
        stock: n.stock + s.inventoryUnits,
        sales: n.sales + s.salesCount,
      }),
      { revenue: 0, cash: 0, stock: 0, sales: 0 },
    );
    root.innerHTML = `<div class="heading"><div><div class="eyebrow">${shop < 0 ? "ВСЕ МАГАЗИНЫ" : "СКЛАД И КАССА ТОЧКИ"}</div><h1>${esc(title)}</h1><p>${selectedDate ? "Показатели за выбранный день" : "Показатели за всё время"}. Остатки товара и наличных — текущие.</p></div></div>${periodPicker()}<div class="summary-strip"><div><span>На складе</span><b>${summary.stock} <small>шт.</small></b></div><div><span>Выручка после возвратов</span><b>${money(summary.revenue)}</b></div><div><span>Продажи ${selectedDate ? "за день" : "за всё время"}</span><b>${summary.sales} <small>документов</small></b></div><div><span>Наличные сейчас</span><b>${money(summary.cash)}</b></div></div>${shop < 0 ? `<div class="shop-grid">${report.shops.map((s) => `<button class="shop-card panel" aria-label="Открыть магазин ${s.shop + 1}" onclick="selectShop(${s.shop},'home')"><span class="eyebrow">МАГАЗИН ${s.shop + 1}</span><h2>${esc(s.name)}</h2><dl><div><dt>На складе</dt><dd>${s.inventoryUnits} шт.</dd></div><div><dt>Выручка</dt><dd>${money(s.netRevenue)}</dd></div><div><dt>Наличные сейчас</dt><dd>${money(s.cash)}</dd></div><div><dt>Продажи</dt><dd>${s.salesCount}</dd></div></dl><b>Открыть склад и кассу →</b></button>`).join("")}</div>` : `<div class="quick-actions"><button onclick="go('products')"><span class="quick-icon">▣</span><b>Склад магазина</b><small>Остатки и серийные номера</small></button><button onclick="go('finance')"><span class="quick-icon">₽</span><b>Касса магазина</b><small>Деньги и кассовые операции</small></button><button onclick="newDocument('transfer')"><span class="quick-icon">⇄</span><b>Переместить товар</b><small>Отправить в другой магазин</small></button></div>`}<div class="quick-actions">${[
      ["receipt", "↓", "Принять товар", "Добавить поступление в магазин"],
      ["transfer", "⇄", "Переместить", "Отправить товар в другой магазин"],
      ["sale", "↗", "Продать", "Выбрать товары и оформить продажу"],
    ]
      .map(
        ([type, icon, title, text]) =>
          `<button onclick="newDocument('${type}')"><span class="quick-icon">${icon}</span><b>${title}</b><small>${text}</small></button>`,
      )
      .join(
        "",
      )}</div>${!data.products.length ? `<div class="start-banner"><div><h2>Добавьте товары в каталог</h2><p>Создайте позицию, затем внесите поступление.</p></div>${priv() ? button("＋ Создать первую позицию", "editProduct()", "primary") : ""}</div>` : ""}<div class="dashboard-grid"><section class="panel"><div class="section-head"><h2>Нужно принять</h2><span class="section-number">${pending.length}</span></div>${pending.map(docRow).join("") || '<div class="quiet-empty"><b>Все отправления приняты</b></div>'}</section><section class="panel"><div class="section-head"><h2>Продолжить работу</h2></div>${
      scopedDocs
        .filter((d) => d.status === "draft" && canStore(d.shop))
        .slice(-5)
        .reverse()
        .map(docRow)
        .join("") ||
      '<div class="quiet-empty"><b>Незавершённых документов нет</b></div>'
    }</section></div><div class="section-head recent-head"><h2>Последние операции</h2></div><div class="panel">${
      scopedDocs
        .filter((d) => !["draft", "cancelled"].includes(d.status))
        .slice(-5)
        .reverse()
        .map(docRow)
        .join("") ||
      '<div class="small-empty">Проведённые документы появятся здесь.</div>'
    }</div>`;
  } catch (error) {
    if (root === $("content"))
      root.innerHTML = '<div class="error">' + esc(error.message) + "</div>";
  }
}
function operationsHome() {
  $("content").innerHTML =
    `<div class="heading"><div><div class="eyebrow">ДОПОЛНИТЕЛЬНЫЕ ДЕЙСТВИЯ</div><h1>Другие операции</h1><p>Возвраты, списания и контроль истории.</p></div></div><div class="operation-grid">${[
      [
        "↩",
        "Возврат покупателя",
        "Найти исходную продажу и вернуть товар в магазин",
        "newDocument('customer_return')",
      ],
      [
        "↥",
        "Возврат поставщику",
        "Вернуть товар поставщику с указанием причины",
        "newDocument('supplier_return')",
      ],
      [
        "−",
        "Списание",
        "Списать повреждённый или утраченный товар",
        "newDocument('writeoff')",
      ],
      [
        "◷",
        "История действий",
        "Посмотреть, кто и когда оформил операцию",
        "go('audit')",
      ],
    ]
      .map(
        ([icon, title, text, action]) =>
          `<button class="operation-card" onclick="${action}"><span class="quick-icon">${icon}</span><h2>${title}</h2><p>${text}</p><span class="operation-arrow">→</span></button>`,
      )
      .join(
        "",
      )}</div><div class="card-actions">${button("Все возвраты", "go('returns')")}${button("Все списания", "go('writeoff')")}</div>`;
}
async function adminHome() {
  if (session.user.role !== "admin") {
    go("home");
    return;
  }
  const root = $("content");
  root.innerHTML =
    '<div class="small-empty">Загружаем администрирование…</div>';
  try {
    users = await api("/api/users");
    if (tab !== "admin" || root !== $("content")) return;
    const unknown = data.products.filter((p) => p.buy === null),
      missingManagers = data.shops
        .map((name, i) => ({ name, i }))
        .filter(
          ({ i }) =>
            !users.some(
              (u) => u.active && u.role === "manager" && u.shop === i,
            ),
        );
    root.innerHTML = `<div class="heading"><div><div class="eyebrow">ГЛАВНЫЙ АДМИНИСТРАТОР</div><h1>Администрирование</h1><p>Сотрудники, доступы и готовность магазинов к работе.</p></div>${button("＋ Добавить сотрудника", "editUser()", "primary")}</div><div class="admin-grid"><section class="panel"><div class="section-head"><h2>Магазины</h2><span class="section-number">3</span></div>${data.shops
      .map((n, i) => {
        const managers = users.filter(
          (u) => u.active && u.role === "manager" && u.shop === i,
        );
        return `<div class="store-admin"><span class="store-symbol">▣</span><div><h3>${esc(n)}</h3><p>${managers.length ? managers.map((u) => esc(u.name)).join(", ") : "Менеджер ещё не назначен"}</p></div><b>${data.products.reduce((n, p) => n + p.quantities[i], 0)} <small>шт.</small></b></div>`;
      })
      .join(
        "",
      )}</section><section class="panel"><div class="section-head"><h2>Что проверить</h2></div><button class="attention-row" onclick="showUnknownPurchases()"><span class="attention-icon">?</span><div><b>Закупочные цены</b><p>${unknown.length ? "Не заполнены у " + unknown.length + " позиций" : "Все закупочные цены заполнены"}</p></div><span>→</span></button><button class="attention-row" onclick="go('users')"><span class="attention-icon">♙</span><div><b>Доступы магазинов</b><p>${missingManagers.length ? "Нет менеджера: " + missingManagers.map((x) => esc(x.name)).join(", ") : "Во всех магазинах назначены менеджеры"}</p></div><span>→</span></button><div class="admin-help"><b>Закупка скрыта от менеджеров</b><p>Менеджер работает с документами своего магазина и видит продажные цены.</p></div></section></div><div class="section-head recent-head"><div><h2>Сотрудники <span class="muted">${users.length}</span></h2><p>Личные аккаунты и назначенные роли.</p></div>${button("Все сотрудники", "go('users')", "export")}</div><div class="panel">${users
      .slice(0, 8)
      .map(
        (u) =>
          `<button class="doc-link" onclick="editUser('${u.id}')"><div class="doc-main"><span class="person-icon">${esc(u.name[0])}</span><div><b>${esc(u.name)}</b><span>${roles[u.role]}${u.shop !== null ? " · " + esc(data.shops[u.shop]) : ""}</span></div></div><span class="status ${u.active ? "received" : "cancelled"}">${u.active ? "Активен" : "Отключён"}</span></button>`,
      )
      .join("")}</div>`;
  } catch (e) {
    root.innerHTML = '<div class="error">' + esc(e.message) + "</div>";
  }
}
function showUnknownPurchases() {
  const rows = data.products.filter((p) => p.buy === null);
  show(
    `<h2>Неизвестные закупочные цены</h2><p>Заполните цены, когда появятся данные о закупке.</p>${rows.map((p) => `<button class="doc-link" onclick="editProduct('${p.id}')"><div><b>${esc(p.name)}</b><span>${esc(p.barcode)}</span></div><span class="status partial">Указать цену →</span></button>`).join("") || '<div class="quiet-empty"><b>Все цены заполнены</b></div>'}`,
  );
}

let financeRequest = 0;
async function financeScreen() {
  const root = $("content"),
    request = ++financeRequest;
  root.innerHTML = '<div class="small-empty">Загружаем кассу…</div>';
  try {
    const report = await api(reportURL());
    if (
      tab !== "finance" ||
      root !== $("content") ||
      request !== financeRequest
    )
      return;
    const shop = scopeShop();
    root.innerHTML = `<div class="heading"><div><div class="eyebrow">ФИНАНСЫ И КАССА</div><h1>${shop < 0 ? "Деньги по точкам" : `Касса · Магазин ${shop + 1}`}</h1><p>Продажи и операции ${selectedDate ? "за выбранный день" : "за всё время"}. Текущая касса учитывает всю историю.</p></div><div class="card-actions">${button("＋ Кассовая операция", "cashDialog()", "primary")}${button("⇄ Перевести деньги", "cashTransferDialog()", "primary")}</div></div>${periodPicker()}${report.shops.map((s) => `<section class="panel finance-shop"><h2>${esc(s.name)}</h2><div class="summary-strip"><div><span>Выручка после возвратов</span><b>${money(s.netRevenue)}</b></div><div><span>Наличные сейчас</span><b>${money(s.cash)}</b></div><div><span>Наличные на начало ${selectedDate ? "дня" : "учёта"}</span><b>${money(s.cashOpening)}</b></div><div><span>Наличные на конец ${selectedDate ? "дня" : "периода"}</span><b>${money(s.cashClosing)}</b></div></div><div class="cash-details"><span>Наличные продажи: <b>${money(s.cashSales)}</b></span><span>Карта: <b>${money(s.cardSales)}</b></span><span>Возвраты: <b>${money(s.refunds)}</b></span><span>Расходы: <b>${money(s.expenses)}</b></span>${priv() ? `<span>Себестоимость: <b>${money(s.knownCost)}</b></span><span>Прибыль: <b>${s.profit === null ? "Не определена" : money(s.profit)}</b></span>` : ""}</div></section>`).join("")}<div class="section-head recent-head"><h2>Кассовые операции</h2></div><div class="panel">${report.entries.map((e) => `<div class="event"><div><b>${cashTypes[e.type]} · ${esc(data.shops[e.shop])}${e.type === "transfer" ? " → " + esc(data.shops[e.to]) : ""} · ${money(e.amount)}</b><p>${esc(e.reason)} · ${esc(e.actor)}</p></div><time>${fmt(e.at)}</time></div>`).join("") || '<div class="small-empty">Ручных операций за период нет. Продажи и возвраты учтены автоматически.</div>'}</div>`;
  } catch (error) {
    if (root === $("content"))
      root.innerHTML = '<div class="error">' + esc(error.message) + "</div>";
  }
}
const cashTypes = {
  opening: "Начальный остаток",
  deposit: "Внесение",
  withdrawal: "Изъятие",
  expense: "Расход",
  transfer: "Перевод между кассами",
};
function cashDialog() {
  show(
    `<h2>Кассовая операция</h2><form><label>Магазин<select name="shop">${storeOptions(scopeShop() >= 0 ? scopeShop() : 0)}</select></label><label>Тип<select name="type">${Object.entries(
      cashTypes,
    )
      .filter(([k]) => k !== "transfer" && (priv() || k !== "opening"))
      .map(([k, v]) => `<option value="${k}">${v}</option>`)
      .join(
        "",
      )}</select></label>${priceInput("amount", "Сумма, ₽", 0)}<label>Назначение<textarea name="reason" maxlength="500" required></textarea></label><p>Изъятие и расход не могут превышать наличные в кассе.</p><button type="submit" data-submit class="primary full">Сохранить</button></form>`,
    (f) =>
      saveCash({
        shop: Number(f.get("shop")),
        type: f.get("type"),
        amount: price(f, "amount"),
        reason: f.get("reason"),
      }),
  );
}
function cashTransferDialog() {
  const source = scopeShop() >= 0 ? scopeShop() : 0;
  show(
    `<h2>Перевод между кассами</h2><form><label>Откуда<select name="shop">${storeOptions(source)}</select></label><label>Куда<select name="to">${storeOptions((source + 1) % 3, false)}</select></label>${priceInput("amount", "Сумма, ₽", 0)}<label>Назначение<textarea name="reason" maxlength="500" required></textarea></label><p>Одна операция уменьшит кассу отправителя и увеличит кассу получателя. Общая сумма денег и прибыль не изменятся.</p><button type="submit" data-submit class="primary full">Перевести деньги</button></form>`,
    (f) =>
      saveCash({
        type: "transfer",
        shop: Number(f.get("shop")),
        to: Number(f.get("to")),
        amount: price(f, "amount"),
        reason: f.get("reason"),
      }),
  );
}
async function saveCash(body) {
  if (busy) return;
  busy = true;
  $("form")
    .querySelectorAll("button[type=submit]")
    .forEach((b) => (b.disabled = true));
  try {
    await api("/api/cash", body);
    $("dialog").close();
    await financeScreen();
    toast("Операция сохранена");
  } catch (error) {
    toast(error.message);
  } finally {
    busy = false;
    $("form")
      .querySelectorAll("button[type=submit]")
      .forEach((b) => (b.disabled = false));
  }
}
