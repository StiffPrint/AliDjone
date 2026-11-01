import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { Store } from "./store.mjs";
import { digest, token, hashPassword, verifyPassword } from "./auth.mjs";
import {
  apply,
  staffChange,
  publicUser,
  view,
  uid,
  AccessError,
} from "../lib/warehouse.mjs";
import { finance, cashChange } from "../lib/finance.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const errorResponse = (status, message) =>
  Object.assign(Error(message), { status });
const cookies = (request) =>
  Object.fromEntries(
    (request.headers.cookie || "")
      .split(";")
      .map((part) => part.trim().split("=")),
  );

export async function createApp(options = {}) {
  const store = new Store(
    options.database ||
      process.env.DATABASE_PATH ||
      join(root, "data/warehouse.sqlite"),
  );
  const origin =
    options.origin || process.env.PUBLIC_ORIGIN || "http://127.0.0.1:5180";
  const secure = new URL(origin).protocol === "https:";
  const revision = await readFile(join(root, "REVISION"), "utf8").then(
    (value) => value.trim(),
    (error) => {
      if (error.code === "ENOENT") return "development";
      throw error;
    },
  );
  const cookieName = secure ? "__Host-alidjone" : "alidjone";
  const sessionCookie = (value, age = 43200) =>
    `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? "; Secure" : ""}`;
  const dummyHash = await hashPassword(token());
  const adminLogin = (
    options.adminLogin ||
    process.env.ADMIN_LOGIN ||
    "admin@alidjone.local"
  )
    .trim()
    .toLowerCase();
  const adminPassword = options.adminPassword || process.env.ADMIN_PASSWORD;
  if (!store.db.prepare("SELECT id FROM staff LIMIT 1").get()) {
    if (!adminPassword)
      throw Error(
        "Для первого запуска задайте ADMIN_PASSWORD (минимум 12 символов)",
      );
    const passwordHash = await hashPassword(adminPassword);
    store.transaction(() => {
      if (store.db.prepare("SELECT id FROM staff LIMIT 1").get()) return;
      const before = store.read(),
        state = structuredClone(before);
      state.staff.push({
        id: uid(),
        login: adminLogin,
        name: "Администратор",
        role: "admin",
        shop: null,
        active: 1,
      });
      store.save(before, state);
      store.db
        .prepare("UPDATE staff SET password_hash=? WHERE login=?")
        .run(passwordHash, adminLogin);
    });
  }
  // Bounded process-local throttling; no credentials or session tokens are logged.
  const attempts = new Map();
  let loginsInFlight = 0;
  function throttle(request, login) {
    const remote = request.socket.remoteAddress;
    const address = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)
      ? request.headers["x-real-ip"] || remote
      : remote;
    const keys = [`ip:${address}`, `account:${login}`],
      time = Date.now();
    for (const [key, item] of attempts)
      if (item.until < time) attempts.delete(key);
    if (attempts.size > 10000 || loginsInFlight >= 4)
      throw errorResponse(429, "Слишком много попыток. Повторите позже.");
    for (const key of keys) {
      const item = attempts.get(key) || {
        count: 0,
        until: time + 15 * 60 * 1000,
      };
      if (item.count >= (key.startsWith("ip:") ? 30 : 12))
        throw errorResponse(
          429,
          "Слишком много попыток. Повторите через 15 минут.",
        );
      item.count++;
      attempts.set(key, item);
    }
  }
  function authenticated(request) {
    const raw = cookies(request)[cookieName];
    if (!raw || raw.length > 100) throw errorResponse(401, "Войдите в аккаунт");
    const session = store.db
      .prepare("SELECT * FROM sessions WHERE token_hash=? AND expires>?")
      .get(digest(raw), Date.now());
    if (!session) throw errorResponse(401, "Сессия истекла. Войдите снова");
    const row = store.db
      .prepare("SELECT payload FROM staff WHERE id=?")
      .get(session.user_id);
    const user = row && JSON.parse(row.payload);
    if (!user?.active) throw errorResponse(401, "Доступ отключён");
    return { session, user };
  }
  async function body(request) {
    if (!request.headers["content-type"]?.startsWith("application/json"))
      throw errorResponse(400, "Ожидается JSON");
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 128 * 1024) throw errorResponse(413, "Слишком большой запрос");
      chunks.push(chunk);
    }
    let value;
    try {
      value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw errorResponse(400, "Некорректный JSON");
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw errorResponse(400, "Некорректный запрос");
    return value;
  }
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "same-origin");
    response.setHeader("X-Frame-Options", "DENY");
    // The existing UI uses inline event handlers. No remote script sources.
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    const json = (data, status = 200) => {
      response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify(data));
    };
    try {
      const path = new URL(request.url, origin).pathname;
      if (request.method === "GET" && path === "/healthz") {
        const ok =
          store.db.prepare("PRAGMA quick_check").get().quick_check === "ok";
        return json({ ok, revision }, ok ? 200 : 503);
      }
      if (request.method === "GET" && path === "/api/session") {
        try {
          const { user, session } = authenticated(request);
          return json({ user: publicUser(user), csrf: session.csrf });
        } catch {
          return json({ user: null });
        }
      }
      if (request.method === "POST") {
        if (request.headers.origin !== origin)
          throw errorResponse(403, "Недопустимый источник запроса");
        const data = await body(request);
        if (path === "/api/login") {
          const login = String(data.login || "")
            .trim()
            .toLowerCase();
          if (login.length > 200) throw errorResponse(400, "Проверьте логин");
          throttle(request, login);
          const row = store.db
            .prepare("SELECT * FROM staff WHERE login=?")
            .get(login);
          loginsInFlight++;
          let valid;
          try {
            valid = await verifyPassword(
              data.password,
              row?.password_hash || dummyHash,
            );
          } finally {
            loginsInFlight--;
          }
          // Re-read after asynchronous password work to observe revocations.
          const latest =
            row &&
            store.db.prepare("SELECT * FROM staff WHERE id=?").get(row.id);
          const user = latest && JSON.parse(latest.payload);
          if (
            !valid ||
            !user?.active ||
            latest.password_hash !== row.password_hash
          )
            throw errorResponse(401, "Неверный логин или пароль");
          const raw = token(),
            csrf = token();
          store.db
            .prepare("DELETE FROM sessions WHERE expires<?")
            .run(Date.now());
          store.db
            .prepare(
              "INSERT INTO sessions(token_hash,user_id,csrf,expires) VALUES(?,?,?,?)",
            )
            .run(digest(raw), user.id, csrf, Date.now() + 43200_000);
          response.setHeader("Set-Cookie", sessionCookie(raw));
          return json({ user: publicUser(user), csrf });
        }
        const auth = authenticated(request);
        if (request.headers["x-csrf-token"] !== auth.session.csrf)
          throw errorResponse(403, "Обновите страницу и повторите действие");
        if (path === "/api/logout") {
          store.db
            .prepare("DELETE FROM sessions WHERE token_hash=?")
            .run(auth.session.token_hash);
          response.setHeader("Set-Cookie", sessionCookie("", 0));
          return json({ ok: true });
        }
        if (path === "/api/password") {
          const row = store.db
            .prepare("SELECT password_hash FROM staff WHERE id=?")
            .get(auth.user.id);
          if (!(await verifyPassword(data.current, row.password_hash)))
            throw errorResponse(400, "Текущий пароль неверен");
          const hashed = await hashPassword(data.password);
          store.transaction(() => {
            // Guard against a concurrent administrator password reset.
            const result = store.db
              .prepare(
                "UPDATE staff SET password_hash=? WHERE id=? AND password_hash=?",
              )
              .run(hashed, auth.user.id, row.password_hash);
            if (!result.changes)
              throw errorResponse(409, "Пароль уже изменён. Войдите заново");
            store.db
              .prepare("DELETE FROM sessions WHERE user_id=?")
              .run(auth.user.id);
          });
          response.setHeader("Set-Cookie", sessionCookie("", 0));
          return json({ ok: true });
        }
        if (!["/api/action", "/api/users", "/api/cash"].includes(path))
          throw errorResponse(404, "Маршрут не найден");
        const key = request.headers["idempotency-key"];
        if (typeof key !== "string" || !/^[\w-]{16,100}$/.test(key))
          throw errorResponse(
            400,
            "Отсутствует ключ операции. Обновите страницу",
          );
        let hashed;
        if (path === "/api/users") {
          if (auth.user.role !== "admin")
            throw new AccessError(
              "Только администратор управляет сотрудниками",
            );
          if (!data.id || data.password)
            hashed = await hashPassword(data.password);
        }
        const requestHash = digest(path + JSON.stringify(data));
        const result = store.transaction(() => {
          const { user } = authenticated(request);
          const previous = store.db
            .prepare(
              "SELECT request_hash,result FROM operations WHERE user_id=? AND key=?",
            )
            .get(user.id, key);
          if (previous) {
            if (previous.request_hash !== requestHash)
              throw errorResponse(
                409,
                "Ключ операции уже использован для другого запроса",
              );
            return JSON.parse(previous.result);
          }
          const before = store.read(),
            state = structuredClone(before);
          let value;
          if (path === "/api/users") value = staffChange(state, data, user);
          else if (path === "/api/cash") value = cashChange(state, data, user);
          else {
            if (
              state.documents.length >= 100000 ||
              state.products.length >= 100000
            )
              throw Error(
                "Достигнут предел активных данных. Обратитесь к администратору",
              );
            value = apply(state, data, user);
          }
          store.save(before, state);
          if (path === "/api/users") {
            if (hashed)
              store.db
                .prepare("UPDATE staff SET password_hash=? WHERE id=?")
                .run(hashed, value);
            if (data.id)
              store.db
                .prepare("DELETE FROM sessions WHERE user_id=?")
                .run(value);
          }
          const record = { result: value };
          store.db
            .prepare(
              "INSERT INTO operations(user_id,key,request_hash,result,created) VALUES(?,?,?,?,?)",
            )
            .run(user.id, key, requestHash, JSON.stringify(record), Date.now());
          return record;
        });
        if (path === "/api/users" || path === "/api/cash")
          return json({ ok: true, ...result });
        return json({
          ...result,
          state: view(store.read(), authenticated(request).user),
        });
      }
      if (request.method === "GET" && path.startsWith("/api/")) {
        const { user } = authenticated(request);
        const state = store.read();
        if (path === "/api/state") return json(view(state, user));
        if (path === "/api/finance") return json(finance(state, user));
        if (path === "/api/users") {
          if (user.role !== "admin")
            throw new AccessError(
              "Только администратор управляет сотрудниками",
            );
          return json(state.staff.map(publicUser));
        }
        throw errorResponse(404, "Маршрут не найден");
      }
      if (request.method !== "GET" && request.method !== "HEAD")
        throw errorResponse(405, "Метод не разрешён");
      const assets = {
        "/": ["index.html", "text/html"],
        "/app.js": ["app.js", "text/javascript"],
        "/style.css": ["style.css", "text/css"],
        "/favicon.svg": ["favicon.svg", "image/svg+xml"],
      };
      const asset = assets[path];
      if (!asset) throw errorResponse(404, "Страница не найдена");
      const content = await readFile(join(root, "public", asset[0]));
      response.writeHead(200, { "Content-Type": asset[1] + "; charset=utf-8" });
      response.end(request.method === "HEAD" ? undefined : content);
    } catch (error) {
      const status = error.status || (error instanceof AccessError ? 403 : 400);
      if (
        error.code?.startsWith("SQLITE") ||
        error.code === "ERR_SQLITE_ERROR"
      ) {
        console.error("SQLite request failure:", error.code);
        return json(
          {
            error:
              "Не удалось сохранить данные. Повторите операцию с тем же ключом.",
          },
          503,
        );
      }
      json(
        { error: status >= 500 ? "Внутренняя ошибка сервера" : error.message },
        status,
      );
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 40;
  return { server, store, origin };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const app = await createApp();
  const port = Number(process.env.PORT || 5180);
  app.server.listen(port, process.env.HOST || "127.0.0.1", () =>
    console.log(`AliDjone listening on ${port}`),
  );
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () => {
      app.server.close(() => {
        app.store.close();
        process.exit(0);
      });
      setTimeout(() => process.exit(1), 10000).unref();
    });
}
