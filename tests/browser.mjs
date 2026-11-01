// Install Playwright outside this application; pass PLAYWRIGHT_MODULE if needed.
import assert from "node:assert/strict";
import { createApp } from "../server/server.mjs";
import { apply } from "../lib/warehouse.mjs";
import { hashPassword } from "../server/auth.mjs";
import { mkdirSync } from "node:fs";

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
const password = "Browser-only-Password-934!";
const app = await createApp({
  database: ":memory:",
  origin: "http://127.0.0.1:5198",
  adminLogin: "admin@example.com",
  adminPassword: password,
});
const before = app.store.read(),
  state = structuredClone(before),
  admin = state.staff[0];
const run = (body) => apply(state, body, admin);
const product = run({
  action: "product",
  product: {
    name: "Тестовый телефон",
    barcode: "TEST-001",
    kind: "phone",
    buy: 1000000,
    sell: 1500000,
  },
});
const receipt = run({ action: "create", type: "receipt", shop: 0 });
run({ action: "line", id: receipt, product });
const line = state.documents.at(-1).lines[0].id;
for (const serial of ["BROWSER-SALE", "BROWSER-LOSS"])
  run({ action: "scan", id: receipt, line, serial });
run({ action: "post", id: receipt });
state.staff.push({
  id: "browser-manager",
  login: "manager@example.com",
  name: "Менеджер точки",
  role: "manager",
  shop: 0,
  active: 1,
});
app.store.transaction(() => app.store.save(before, state));
app.store.db
  .prepare("UPDATE staff SET password_hash=? WHERE id=?")
  .run(await hashPassword(password), "browser-manager");
await new Promise((resolve) => app.server.listen(5198, "127.0.0.1", resolve));
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH }
    : {}),
  args: ["--no-sandbox"],
});
const errors = [];
mkdirSync("outputs/browser", { recursive: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => dialog.accept());
  async function login(email) {
    await page.goto("http://127.0.0.1:5198");
    await page.locator("#login-form input[name=login]").fill(email);
    await page.locator("#login-form input[name=password]").fill(password);
    await page.locator("#login-form button").click();
    await page
      .getByRole("heading", {
        name:
          email === "manager@example.com"
            ? "Магазин 1 · Островок"
            : "Рабочий стол",
        exact: true,
      })
      .waitFor();
  }
  await login("admin@example.com");
  assert.equal(await page.locator(".shop-card").count(), 3);
  await page
    .getByRole("button", { name: "Открыть магазин 2", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Магазин 2 · Центральный", exact: true })
    .waitFor();
  await page.getByRole("button", { name: /Склад магазина/ }).click();
  assert.equal(await page.locator("#shop-scope").inputValue(), "1");
  await page.locator("aside").getByRole("button", { name: "Главная" }).click();
  await page
    .getByRole("heading", { name: "Магазин 2 · Центральный", exact: true })
    .waitFor();
  await page.getByRole("button", { name: /Принять товар/ }).click();
  assert.equal(await page.locator("#form select[name=shop]").inputValue(), "1");
  await page.locator("#close-dialog").click();
  await page.locator("#shop-scope").selectOption("-1");
  await page
    .getByRole("heading", { name: "Рабочий стол", exact: true })
    .waitFor();
  await page.locator("#report-date").fill("2026-01-01");
  await page.locator("#report-date").dispatchEvent("change");
  await page.getByRole("button", { name: "Сегодня", exact: true }).click();
  await page.locator(".shop-card").first().waitFor();
  await page.screenshot({
    path: "outputs/browser/dashboard-desktop.png",
    fullPage: true,
  });
  await page.locator("aside").getByRole("button", { name: "Товары" }).click();
  await page.getByRole("button", { name: "＋ Создать позицию" }).click();
  await page.locator("#form input[name=name]").fill("Телефон из интерфейса");
  await page.locator("#form input[name=barcode]").fill("UI-RECEIPT-001");
  await page.locator("#form input[name=buy]").fill("100");
  await page.locator("#form input[name=sell]").fill("200");
  await page.locator("#form button[type=submit]").click();
  await page
    .locator("#form")
    .getByRole("heading", { name: "Телефон из интерфейса" })
    .waitFor();
  await page.locator("#close-dialog").click();
  await page.locator("aside").getByRole("button", { name: "Приёмка" }).click();
  await page.getByRole("button", { name: "＋ Новая приёмка" }).click();
  await page.locator("#form button[type=submit]").click();
  await page.getByRole("button", { name: "＋ Добавить позицию" }).click();
  await page.locator("#receipt-product-search").fill("UI-RECEIPT-001");
  await page.locator("#receipt-product-search").press("Enter");
  await page.locator("#receipt-scan").fill("BROWSER-RECEIPT");
  await page.locator("#receipt-scan").press("Enter");
  await page
    .locator("#scan-log")
    .getByText(/BROWSER-RECEIPT.*добавлен/)
    .waitFor();
  await page.getByRole("button", { name: "К документу", exact: true }).click();
  await page.getByRole("button", { name: "Провести документ" }).click();
  await page.locator(".heading .status.posted").waitFor();
  await page
    .locator("aside")
    .getByRole("button", { name: "Администрирование" })
    .click();
  await page.getByRole("button", { name: "＋ Добавить сотрудника" }).click();
  await page.locator("#form input[name=name]").fill("Сотрудник браузер");
  await page.locator("#form input[name=login]").fill("staff-ui@example.com");
  await page.locator("#form input[name=password]").fill(password);
  await page.locator("#form select[name=shop]").selectOption("2");
  await page.locator("#form button[type=submit]").click();
  await page.locator("dialog").waitFor({ state: "hidden" });
  await page.getByText("Сотрудник браузер").first().waitFor();
  await page
    .locator("aside")
    .getByRole("button", { name: "Финансы и касса" })
    .click();
  await page.getByRole("heading", { name: "Деньги по точкам" }).waitFor();
  await page.getByRole("button", { name: "＋ Кассовая операция" }).click();
  await page.locator("#form select[name=type]").selectOption("opening");
  await page.locator("#form input[name=amount]").fill("1000");
  await page.locator("#form textarea[name=reason]").fill("Размен");
  await page.locator("#form button[type=submit]").click();
  await page.locator("dialog").waitFor({ state: "hidden" });
  await page.getByText("Начальный остаток · Островок").waitFor();
  await page.screenshot({
    path: "outputs/browser/finance-desktop.png",
    fullPage: true,
  });
  await page
    .locator("aside")
    .getByRole("button", { name: "Выйти из аккаунта" })
    .click();
  await page.locator("#login-form").waitFor();
  await login("manager@example.com");
  assert.equal(await page.locator("#shop-scope option").count(), 1);
  await page.locator("aside").getByRole("button", { name: "Касса" }).click();
  await page
    .getByRole("heading", { name: "Касса · Магазин 1", exact: true })
    .waitFor();
  assert.equal(await page.getByText("Прибыль:", { exact: false }).count(), 0);
  await page
    .getByRole("button", { name: "⇄ Перевести деньги", exact: true })
    .click();
  assert.equal(await page.locator("#form select[name=shop] option").count(), 1);
  await page.locator("#form select[name=to]").selectOption("1");
  await page.locator("#form input[name=amount]").fill("100");
  await page
    .locator("#form textarea[name=reason]")
    .fill("Перевод на вторую точку");
  await page.locator("#form button[type=submit]").click();
  await page.locator("dialog").waitFor({ state: "hidden" });
  await page.getByText("Перевод на вторую точку", { exact: false }).waitFor();
  const { finance } = await import("../lib/finance.mjs");
  assert.equal(finance(app.store.read(), admin).shops[1].cash, 10000);
  await page.screenshot({
    path: "outputs/browser/store-cash-transfer.png",
    fullPage: true,
  });
  await page.locator("aside").getByRole("button", { name: "Главная" }).click();
  await page
    .getByRole("heading", { name: "Магазин 1 · Островок", exact: true })
    .waitFor();
  assert.equal(
    await page
      .locator("aside")
      .getByRole("button", { name: "Финансы и касса" })
      .count(),
    0,
  );
  assert.equal(
    await page
      .locator("aside")
      .getByRole("button", { name: "Администрирование" })
      .count(),
    0,
  );
  await page.getByRole("button", { name: /Продать.*Выбрать товары/ }).click();
  await page.locator("#form select[name=payment]").selectOption("cash");
  await page.locator("#form button[type=submit]").click();
  await page.locator("#outgoing-serial-input").waitFor();
  await page.locator("#outgoing-serial-input").fill("BROWSER-SALE");
  await page.locator("#outgoing-serial-input").press("Enter");
  await page
    .locator(".document-line .tags")
    .getByText("BROWSER-SALE")
    .waitFor();
  await page.getByRole("button", { name: "Провести документ" }).click();
  await page.locator(".heading .status.posted").waitFor();
  await page.screenshot({
    path: "outputs/browser/sale-desktop.png",
    fullPage: true,
  });
  await page
    .locator("aside")
    .getByRole("button", { name: "Другие операции" })
    .click();
  await page
    .getByRole("button", { name: /Списание.*Списать повреждённый/ })
    .click();
  await page.locator("#form textarea[name=reason]").fill("Повреждён экран");
  await page.locator("#form button[type=submit]").click();
  await page.locator("#outgoing-serial-input").waitFor();
  await page.locator("#outgoing-serial-input").fill("BROWSER-LOSS");
  await page.locator("#outgoing-serial-input").press("Enter");
  await page
    .locator(".document-line .tags")
    .getByText("BROWSER-LOSS")
    .waitFor();
  await page.getByRole("button", { name: "Провести документ" }).click();
  await page.locator(".heading .status.posted").waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .locator(".mobile-nav")
    .getByRole("button", { name: "Главная" })
    .click();
  await page
    .getByRole("heading", { name: "Магазин 1 · Островок", exact: true })
    .waitFor();
  await page.screenshot({
    path: "outputs/browser/dashboard-mobile.png",
    fullPage: true,
  });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
    "Mobile horizontal overflow",
  );
  assert.deepEqual(errors, []);
  const final = app.store.read();
  assert.equal(
    final.units.find((unit) => unit.serial === "BROWSER-SALE").status,
    "sold",
  );
  assert.equal(
    final.units.find((unit) => unit.serial === "BROWSER-LOSS").status,
    "written_off",
  );
  assert.equal(
    final.units.find((unit) => unit.serial === "BROWSER-RECEIPT").status,
    "available",
  );
  assert(
    final.staff.some(
      (user) => user.login === "staff-ui@example.com" && user.shop === 2,
    ),
  );
  console.log(
    "Browser checks passed: admin login, finance, cash, manager permissions, typed-serial sale/writeoff, desktop and mobile.",
  );
} finally {
  await browser.close();
  await new Promise((resolve) => app.server.close(resolve));
  app.store.close();
}
