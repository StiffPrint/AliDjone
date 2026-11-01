// Read-only production checks, apart from login/logout and a service restart.
import { readFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
const access = readFileSync(
  process.env.ACCESS_FILE || "outputs/admin-access.txt",
  "utf8",
);
const base = access.match(/^Адрес: (.+)$/m)[1];
const login = access.match(/^Логин: (.+)$/m)[1];
const password = access.match(/^Пароль: (.+)$/m)[1];
const browser = await chromium.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox"],
});
mkdirSync("outputs/browser", { recursive: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  await page.locator("#login-form input[name=login]").fill(login);
  await page.locator("#login-form input[name=password]").fill(password);
  await page.locator("#login-form button").click();
  await page.getByRole("heading", { name: "Рабочий стол" }).waitFor();
  const before = await page.evaluate(async () =>
    (await fetch("/api/state")).json(),
  );
  assert.equal(before.user.role, "admin");
  await page
    .locator("aside")
    .getByRole("button", { name: "Финансы и касса" })
    .click();
  await page.getByRole("heading", { name: "Деньги по точкам" }).waitFor();
  await page.screenshot({
    path: "outputs/browser/production-finance.png",
    fullPage: true,
  });
  const cookie = (await context.cookies()).find(
    (item) => item.name === "__Host-alidjone",
  );
  assert(cookie?.secure && cookie.httpOnly && cookie.sameSite === "Strict");
  execFileSync(
    "ssh",
    [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=8",
      "server2",
      "systemctl restart alidjone.service",
    ],
    { timeout: 15000 },
  );
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const result = await context.request.get(base + "/healthz");
      if (result.ok()) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert(ready, "Production did not restart");
  await page.reload();
  await page.getByRole("heading", { name: "Рабочий стол" }).waitFor();
  const after = await page.evaluate(async () =>
    (await fetch("/api/state")).json(),
  );
  assert.equal(after.user.id, before.user.id);
  assert.deepEqual(after.products, before.products);
  assert.deepEqual(after.documents, before.documents);
  await page.screenshot({
    path: "outputs/browser/production-dashboard.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "outputs/browser/production-mobile.png",
    fullPage: true,
  });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  );
  await page
    .locator(".mobile-nav")
    .getByRole("button", { name: "Выйти", exact: true })
    .click();
  await page.locator("#login-form").waitFor();
  assert.equal((await context.request.get(base + "/api/state")).status(), 401);
  assert.equal(
    (await context.request.get(base + "/data/warehouse.sqlite")).status(),
    404,
  );
  const redirect = await context.request.get(base.replace("https:", "http:"), {
    maxRedirects: 0,
  });
  assert.equal(redirect.status(), 301);
  assert(redirect.headers().location.startsWith(base));
  assert.deepEqual(errors, []);
  console.log(
    "Production HTTPS/browser checks passed: authenticated dashboard and finance, secure cookies, service restart with SQLite/session persistence, mobile layout, logout, anonymous denial, private file denial, HTTP redirect.",
  );
  console.log("Production business records were not changed.");
} finally {
  await browser.close();
}
