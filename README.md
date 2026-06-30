# Noon Tracker

Noon Tracker — Telegram-бот на NestJS для непрерывного мониторинга офферов товаров [noon.com UAE](https://www.noon.com/uae-en/). Пользователь отправляет ссылку на товар и при необходимости задаёт целевую цену. Проверка активных SKU выполняется каждую минуту.

Бот уведомляет пользователя, когда:

- сменился доступный оффер с минимальной базовой ценой;
- любой доступный оффер достиг целевой цены или опустился ниже неё.

Подробности: [архитектура](docs/architecture.md), [рабочий процесс](docs/workflow.md) и [отчёт о рефакторинге](docs/refactor.md).

## Возможности

- нормализация ссылок Noon и выделение SKU;
- отображение лидера и остальных доступных офферов при добавлении товара;
- отдельная целевая цена для каждой подписки;
- команды `/list`, `/stop`, `/cancel` и `/help`;
- один запрос к Noon на SKU за минутный цикл независимо от числа подписчиков;
- BullMQ-очереди мониторинга и Telegram-уведомлений;
- Redis для очередей и MongoDB для подписок, снимков и идемпотентных событий;
- retries с exponential backoff и защита от повторных уведомлений;
- автоматическое получение cookies и User-Agent через Playwright;
- Docker Compose для приложения, MongoDB и Redis.

## Технологии

- TypeScript, NestJS, Telegraf;
- BullMQ, Redis;
- Mongoose, MongoDB;
- Axios, Playwright;
- pnpm, Docker Compose.

## Запуск

Требуются Node.js, pnpm, Docker и токен Telegram-бота.

```bash
pnpm install
cp .env.example .env
# заполните BOT_TOKEN и при необходимости PROXY_URL
docker compose up -d redis mongodb
pnpm run dev
```

Для запуска всего стека:

```bash
docker compose up --build -d
docker compose ps
docker compose logs -f app
```

При запуске Node.js вне Docker укажите локальные адреса:

```env
MONGODB_URI=mongodb://localhost:27017/noon-tracker
REDIS_HOST=localhost
```

Полный перечень настроек находится в `.env.example`. Основные параметры Noon:

```env
NOON_API_BASE_URL=https://www.noon.com/_vs/nc/mp-customer-catalog-api
NOON_COUNTRY=ae
NOON_LOCALE=en-ae
NOON_ZONE_CODE=AE_DXB-S14
NOON_REQUEST_TIMEOUT_MS=30000
NOON_COOKIE_REFRESH_MS=240000
NOON_COOKIE_EXPIRY_SKEW_MS=30000
NOON_BROWSER_IDLE_MS=600000
OFFERS_CRON=* * * * *
```

`NOON_COOKIE_REFRESH_MS` ограничивает срок кеширования браузерной сессии. Если постоянный cookie истекает раньше, сессия обновляется заранее с запасом `NOON_COOKIE_EXPIRY_SKEW_MS`. При ответах `401`, `403`, `429` или `503` кеш принудительно сбрасывается и запрос повторяется один раз.

Playwright context создаётся лениво и переиспользуется между обновлениями сессии. `NOON_BROWSER_IDLE_MS` закрывает Chromium после длительного бездействия, чтобы освободить память.

## Проверка

```bash
pnpm run build
pnpm test
pnpm run test:e2e
```

Парсер проверяется на обезличенных fixtures и не требует доступности Noon. Интеграционные тесты очередей требуют работающих MongoDB и Redis.

## Доменные ограничения

- Денежные значения хранятся целым числом филсов: `AED 949.00` представляется как `94900`.
- Базовая цена нормализуется как `sale_price ?? price`; карточные скидки, промокоды и cashback не учитываются.
- Лидер выбирается среди доступных офферов по минимальной цене, а при равенстве — детерминированно по `offerId`.
- Регион доставки фиксируется настройками UAE и должен оставаться одинаковым между проверками.
- `.env`, токены, proxy credentials и значения cookies нельзя коммитить или выводить в логи.

## Статус

Основной пользовательский и фоновый workflow реализован: подписки, получение и нормализация офферов, минутный мониторинг, очереди, хранение состояния и Telegram-уведомления. Браузерная сессия автоматически передаёт извлечённые cookies и User-Agent в Axios; её работу в конкретном окружении Noon необходимо подтверждать runtime-логами и smoke-проверкой, поскольку anti-bot поведение зависит от сети и браузерного профиля.
