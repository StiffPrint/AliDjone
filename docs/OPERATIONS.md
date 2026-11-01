# Эксплуатация и передача проекта

Сверено с конфигурацией развёртывания в этой сессии 1 ноября 2026. Перед
административными изменениями проверь фактические пути и активный релиз.

## Сайт, GitHub и сервер

| Что | Где |
|---|---|
| Сайт | https://alijhone.store |
| Репозиторий | https://github.com/StiffPrint/AliDjone |
| История CI/CD | https://github.com/StiffPrint/AliDjone/actions |
| SSH alias в этой машине | `server2` → `185.219.43.57`, административный доступ |
| Приложение | `/opt/alidjone/current` → каталог в `/opt/alidjone/releases/` |
| Runtime | `/opt/alidjone-runtime/bin/node` |
| Служба / пользователь приложения | `alidjone.service` / `alidjone` |
| Слушающий адрес | `127.0.0.1:5180`, снаружи — Nginx и HTTPS |
| Рабочая SQLite | `/var/lib/alidjone/warehouse.sqlite` |
| Окружение службы | `/etc/alidjone.env` |
| Backup-служба и таймер | `alidjone-backup.service`, `alidjone-backup.timer` |
| Резервные копии | `/var/lib/alidjone/backups/` |

На сервере есть другие проекты. Изменяй только службы/каталоги AliDjone,
не перезапускай общий сервер или посторонние приложения ради этого проекта.

## Доступы

На сайте созданы `admin` и `Store 1`, `Store 2`, `Store 3`. Аккаунты магазинов
соответствуют индексам `0`, `1`, `2`. У пользователя могут появиться новые
сотрудники или измениться пароли: проверяй состояние, не пересоздавай доступы
автоматически при каждом деплое.

Пароли не находятся в GitHub и документации. В текущем локальном checkout есть
игнорируемый `outputs/admin-access.txt` с правами 600. На другой машине доступы
нужно получить от владельца. Не выводи этот файл в общий лог.

Владелец явно попросил короткие пароли для пробной проверки. Они заданы локальным
`provision-staff.mjs --allow-short-test-passwords`. Обычное создание и смена
пароля в HTTP API требуют от 12 символов. Исключение не включается через веб.

`scripts/provision-staff.mjs` получает JSON-массив через stdin и использует
DATABASE_PATH. Он обновляет аккаунт по логину, допускает `replaceLogin` для
переименования с сохранением ID и отзывает сессии изменённых пользователей.
`scripts/set-password.mjs` получает логин аргументом, новый пароль из NEW_PASSWORD
и путь из DATABASE_PATH. Не помещай пароль в аргументы команды или commit.

## Публикация

Обычный путь: изменить исходники → проверки → commit → push в main → дождаться
успеха **обоих** jobs GitHub Actions → сверить `/healthz` с SHA опубликованного кода.
Push сам по себе не доказывает обновление сайта. Провал CI оставляет прежнюю версию.

```bash
gh run list --repo StiffPrint/AliDjone --workflow ci-cd.yml --limit 5
gh run view RUN_ID --repo StiffPrint/AliDjone --log-failed
curl -fsS https://alijhone.store/healthz
ssh server2 'readlink -f /opt/alidjone/current; systemctl is-active alidjone.service'
```

`RUN_ID` — реальный ID из run list. В исходном checkout без REVISION health
возвращает `revision: "development"`; в релизе CI записывает полный SHA в REVISION.

Подробная схема, имена GitHub secrets и ограничения SSH описаны в
[../deploy/CI-CD.md](../deploy/CI-CD.md). Не копируй в workflow личный root-ключ.

Автодеплой создаёт backup, устанавливает отдельный каталог релиза и атомарно
переключает `current`. Тесты загруженного релиза выполняются от `nobody`, затем
перезапускается только `alidjone.service`. При плохом локальном health/revision
receiver откатывает код к прошлой ссылке. Проверка публичного HTTPS выполняется
отдельным шагом CI после переключения. Автоматического отката базы нет.

**Отдельно установленные файлы:** `/usr/local/sbin/alidjone-receive-release` и
`/usr/local/libexec/alidjone-ssh-entrypoint`. Это root-owned копии из deploy/,
обычный релиз их не обновляет. Если меняешь их исходники, отдельно установи
проверенные копии административным SSH и проверь владельца/права. Иначе GitHub
и реальный механизм приёма релизов будут различаться.

Защиту main и GitHub environment в этой сессии включить не удалось: у доступного
GitHub-аккаунта WRITE, изменение правил требует администратора. Workflow сам
ограничивает деплой веткой main и не передаёт секреты в PR-проверки.

## Проверка и восстановление работоспособности

```bash
ssh server2 'systemctl status alidjone.service --no-pager'
ssh server2 'journalctl -u alidjone.service -n 80 --no-pager'
ssh server2 'systemctl show alidjone-backup.service -p Result'
ssh server2 'systemctl list-timers alidjone-backup.timer --no-pager'
```

При `403` на запись сначала проверь Origin/CSRF и права аккаунта, а не снимай
защиту. При `401` проверь cookie/сессию. Если проблема возникла после изменения
receiver, лог упавшего deploy job обычно полезнее журнала самого приложения.
В первой настройке уже исправляли поиск `runuser` в ограниченном PATH:
receiver использует абсолютный `/usr/sbin/runuser`.

Ручной откат к известному релизу выполняется администратором: определить
предыдущий рабочий каталог, атомарно заменить `current`, перезапустить только
alidjone.service и проверить локальный и публичный health. Совместимость старого
кода с базой обязательна. Не восстанавливай старую базу поверх действующей только
потому, что не запустился новый интерфейс.

## Резервирование и импорт

```bash
# Рабочий сервер: штатная согласованная копия SQLite.
ssh server2 'systemctl start alidjone-backup.service'

# Локальный пример для явно выбранной тестовой базы.
DATABASE_PATH="$PWD/data/dev-sandbox.sqlite" BACKUP_DIR="$PWD/data/dev-backups" npm run backup
```

Backup использует SQLite API, проверяет integrity_check и оставляет 14 последних
копий в выбранном каталоге. Копия самодостаточна, без WAL/SHM. Нельзя отдельно
копировать рабочий `.sqlite` и его WAL. Автоматические копии находятся на том же
сервере; отдельное внешнее хранилище пока не настроено.

Восстановление сначала проверяй в отдельном файле: integrity_check,
foreign_key_check и чтение приложением. Замена рабочей базы — отдельная операция
с остановкой записи и сохранением текущего состояния.

Импорт — `node scripts/import-state.mjs source.json target.sqlite`.
Снимок проверяется до открытия целевой базы; целевая база должна быть пустой.
У старых количественных остатков с движениями, но без начальной приёмки нужно
явное `openingBalances` — см. README. После импорта пароли назначаются локально.
Импорт не является способом применить миграцию к существующему складу.

## Локальные артефакты

`outputs/browser/` — снимки из тестовой базы. `outputs/ci-deploy/` — локальные
материалы настроенного деплоя и проверок; там могут быть секреты. Ни эти каталоги,
ни `data/`, `.env*`, `.dev.vars*`, `.sites-runtime/`, `.wrangler/` не публикуются.
Старые архивы в outputs не доказывают текущий релиз — используй health и GitHub.
