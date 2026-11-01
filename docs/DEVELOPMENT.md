# Разработка и проверка

Все команды выполняются из корня репозитория. Нужны Node.js 24.22.1+ и npm;
Python 3 нужен для тестов приёмника деплоя. `npm ci --ignore-scripts` устанавливает
проект по lock-файлу; у приложения нет внешних runtime-зависимостей.

## Запуск в отдельной базе

```bash
npm ci --ignore-scripts
export DATABASE_PATH="$PWD/data/dev-sandbox.sqlite"
export HOST=127.0.0.1
export PORT=5181
export PUBLIC_ORIGIN=http://127.0.0.1:5181
export ADMIN_LOGIN=dev-admin
read -rsp 'Пароль администратора, от 12 символов: ' ADMIN_PASSWORD
export ADMIN_PASSWORD
npm start
```

Открой именно `http://127.0.0.1:5181`: Origin должен совпадать с PUBLIC_ORIGIN,
включая протокол, имя хоста и порт. `localhost` и `127.0.0.1` — разные Origin.
Для наблюдения за изменениями сервера есть `npm run dev`.

ADMIN_PASSWORD нужен только для создания первого сотрудника в пустой базе.
Он не сбрасывает пароль существующего администратора. Node сам не загружает
`.env.local` и `.dev.vars`: параметры берутся из окружения процесса.

Без DATABASE_PATH приложение открывает `data/warehouse.sqlite`. Это может быть
пользовательская локальная база. Для экспериментов всегда указывай отдельный путь.

В текущей машине node/npm могут отсутствовать в стандартном PATH. Проверенный
установленный runtime находится здесь:

```bash
export PATH=/home/fedorkorigin/.local/share/vpn-sales-tools/node-v24.22.1-linux-x64/bin:$PATH
node --version
```

Это особенность текущего компьютера, не переносимое требование приложения.

## Что запускать при изменениях

```bash
npm test
npm run lint
python3 -m unittest discover -s tests -p '*_test.py' -v
bash -n scripts/deploy-ci.sh
sh -n deploy/ssh-entrypoint.sh
npm run build
git diff --check
```

`lint` проверяет синтаксис `.js`/`.mjs`, не стиль и не типы. `build` копирует
исходники в `dist/`, предварительно удаляя старый `dist/`; транспиляции нет.
Исходная документация `docs/` и AGENTS.md живёт в Git, текущая сборка не включает
их в runtime-архив. `npm audit` можно запускать отдельно, а список реальных
зависимостей смотреть в package.json/lock.

На 1 ноября 2026 для версии с магазинами/дневными отчётами прошли 25 Node-тестов,
4 Python-теста и браузерный сценарий. Это исторический результат, а не замена
проверки нового изменения.

| Тест | Что защищает |
|---|---|
| `tests/warehouse.test.mjs` | Документы, серийники, перемещения, возвраты, права |
| `tests/server.test.mjs` | HTTP, CSRF, идемпотентность, изоляция, SQLite, FIFO после reopen |
| `tests/finance.test.mjs` | Свои кассы, переводы, Москва/граница суток, карта/наличные |
| `tests/import-state.test.mjs` | Корректный импорт и отклонение повреждённых снимков |
| `tests/provision.test.mjs` | Логины, локальное создание доступов, хеши и роли |
| `tests/deploy_test.py` | Распаковка релиза и откат ссылки при плохом health check |
| `tests/browser.mjs` | Интерфейс админа/магазина, касса, склад, перевод и мобильный экран |

Тесты используют память и временные SQLite. `Store.transaction()` принимает
синхронный callback; не передавай туда async-функцию. Для прямых доменных проверок
при изменении нескольких сущностей работай с `structuredClone(state)`.

## Браузер без зависимостей в приложении

Linux-пример, такой же принцип используется в CI:

```bash
browser_tools=$(mktemp -d)
npm install --prefix "$browser_tools" --no-package-lock --no-audit --no-fund playwright@1.63.0
"$browser_tools/node_modules/.bin/playwright" install chromium
PLAYWRIGHT_MODULE="$browser_tools/node_modules/playwright/index.mjs" node tests/browser.mjs
```

Для системы без библиотек Chromium используй `playwright install --with-deps chromium`
вместо `install chromium`, если установка системных пакетов уместна в этой среде.
Для установленного Chrome можно задать `CHROME_PATH=/usr/bin/google-chrome`.
Локально также доступен модуль из кеша Python Playwright, но этот путь непереносим;
предпочитай пример выше или настройки CI.

Браузерный тест поднимает отдельный сервер на `127.0.0.1:5198`, создаёт данные
в памяти и кладёт снимки в игнорируемый `outputs/browser/`. Он не использует
рабочие аккаунты и не пишет в production. Освободи порт, если тест не стартует.

`tests/production-smoke.mjs` — другой сценарий: читает локальный файл доступа,
входит на рабочий сайт и **перезапускает службу через SSH**. Не запускай его
как обычный локальный тест. У него есть ожидания к формату файла доступа;
сначала сверяй их с текущим локальным файлом.

## Карта HTTP API

| Метод и путь | Назначение |
|---|---|
| GET `/healthz` | `{ok, revision}`; 503 при неуспешной проверке SQLite |
| GET `/api/session` | Текущий пользователь и CSRF; без сессии user=null |
| POST `/api/login`, `/api/logout` | Вход и выход |
| POST `/api/password` | Смена своего пароля, отзыв всех своих сессий |
| GET `/api/state` | Складская проекция с учётом прав |
| POST `/api/action` | Действия из `apply()` |
| GET `/api/finance?shop=0&date=2026-11-01` | Показатели точки/дня; параметры необязательны |
| POST `/api/cash` | Ручная кассовая операция или перевод |
| GET/POST `/api/users` | Список / изменение сотрудников, только admin |

POST требует точный Origin и `Content-Type: application/json`. Кроме login,
нужна cookie и `X-CSRF-Token`. Для `/api/action`, `/api/cash`, `/api/users`
нужен `Idempotency-Key`: 16–100 букв/цифр/подчёркиваний/дефисов (UUID подходит).
При повторе одного действия сохраняй тот же ключ и тело. На другое действие
создавай новый ключ. Это уже делает клиентский `api()`.

Типовые ошибки: `400` — данные, `401` — сессия, `403` — права/Origin/CSRF,
`409` — конфликт ключа, `429` — лимит входов, `503` — проблема SQLite.
Не заменяй нормальную авторизацию платформенными заголовками или автологином.

## Где менять нужную функцию

- Остатки, серийники, документы: `lib/warehouse.mjs` + профильные тесты.
- Касса, даты, прибыль: `lib/finance.mjs` + `tests/finance.test.mjs`.
- Права: доменные проверки, `view()`, `finance()` и HTTP-тесты; затем меню UI.
- Экран магазина: `selectedShop`, `scopeShop`, `home`, `financeScreen` в app.js.
- Новое сохраняемое поле: доменная логика, Store, импортный валидатор и тест round-trip.
- Деплой: workflow и `deploy/receive-release.py`; установленный root-owned
  receiver обновляется отдельно, подробнее в эксплуатации.
