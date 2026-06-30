# Архитектура Noon Tracker

Связанные документы: [API Noon](api.md), [база данных](database.md), [очереди](queues.md), [рабочий процесс](workflow.md).

## Общая схема

```text
Telegram user
     │
     ▼
  BotModule ───────► tracking_subscriptions (MongoDB)
                         │
                         ▼
QueuesService cron ─► product-monitoring (Redis/BullMQ)
                         │
                         ▼
                MonitoringProcessor
                         │
             NoonClient + NoonSession
                         │
                         ▼
                  Noon catalog API
                         │
                         ▼
              MonitoringService ─► monitored_products
                         │
                         ▼
             notification_events (MongoDB)
                         │
                         ▼
             telegram-notifications (BullMQ)
                         │
                         ▼
              NotificationProcessor ─► Telegram
```

## Границы модулей

### `src/bot`

Telegram-интерфейс. Модуль регистрирует handlers до запуска polling, валидирует пользовательский ввод, отображает лидера и остальные офферы, создаёт подписки и обслуживает `/list` и `/stop`. Сравнение цен и сетевой доступ к Noon в этом модуле не выполняются.

`tracking_subscriptions` связывает Telegram user/chat, SKU, канонический URL, целевую цену, активность, последнего лидера и состояние срабатывания ценового порога.

### `src/noon`

- `noon-url.ts` проверяет UAE-ссылку, извлекает SKU и удаляет tracking query-параметры;
- `NoonSessionService` получает cookies и User-Agent через persistent Playwright context и кеширует результат;
- `NoonClientService` отправляет Axios-запрос с браузерной сессией и явным delivery context;
- `noon-payload.parser.ts` валидирует нестабильный внешний JSON и преобразует его во внутреннюю модель;
- `NoonService` содержит чистую доменную операцию выбора лидера.

Доменная логика не зависит от HTML-селекторов или исходной структуры JSON Noon.

### `src/monitoring`

`MonitoringService` получает один снимок на SKU, сохраняет последний успешный результат, сравнивает его со всеми активными подписками и создаёт события смены лидера или пересечения ценового порога. Ошибка запроса не интерпретируется как отсутствие офферов.

### `src/queues`

Здесь находятся планировщик, BullMQ processors, retries и публикация уведомлений:

- `product-monitoring` — задания проверки уникальных SKU;
- `telegram-notifications` — независимая доставка сообщений;
- `queue_executions` — аудит состояния заданий мониторинга;
- `notification_events` — durable outbox и идемпотентность уведомлений.

### `src/infrastructure`

Глобальные подключения Config, Mongoose и Redis/BullMQ. `ScheduleModule` регистрируется в `QueuesModule`. Адреса и параметры интеграций поступают из конфигурации.

## Данные и инварианты

- Канонический ключ товара — SKU, а не URL.
- Варианты с разными SKU являются разными товарами.
- В одном минутном bucket создаётся не более одного monitoring job на SKU: `monitor-{sku}-{minuteBucket}`.
- Деньги хранятся в минимальных денежных единицах, без floating point.
- Лидер — доступный оффер с минимальной базовой ценой; равенство разрешается по `offerId`.
- Идентичность продавца/оффера определяется устойчивым ID, не отображаемым именем.
- Country, locale и zone code фиксируются конфигурацией.

## Сессия Noon

При первом запросе `NoonSessionService` открывает страницу товара в Playwright, пытается перехватить настоящий catalog request и прочитать его headers. Если request не появился за timeout, используются cookies из browser context. Axios получает `Cookie`, нормализованный `User-Agent` и delivery headers. При наличии `PROXY_URL` Playwright и Axios используют один proxy, чтобы IP-контекст сессии совпадал.

Сессия кешируется до более раннего из двух моментов:

1. `NOON_COOKIE_REFRESH_MS` после создания;
2. самого раннего срока постоянного cookie минус `NOON_COOKIE_EXPIRY_SKEW_MS`.

Session cookies без явного срока жизни используют настроенный TTL. Одновременные запросы используют один `refreshPromise`. Ответы `401`, `403`, `429` и `503` инвалидируют кеш и вызывают одну принудительную попытку обновления.

Логи показывают источник сессии, User-Agent, имена и количество cookies, длину Cookie header и срок кеша. Значения cookies не логируются.

## Надёжность и идемпотентность

Monitoring worker ограничен concurrency и rate limiter, а failed jobs повторяются с exponential backoff. События имеют устойчивые versioned IDs. Уникальный `eventId` одновременно используется в MongoDB и как BullMQ `jobId`, поэтому retry не создаёт новое сообщение.

Ценовое событие создаётся только при пересечении порога сверху вниз. Пока цена остаётся ниже или равна порогу, флаг `targetPriceTriggered` блокирует дубликаты. После возврата цены выше порога подписка перевооружается.

Notification worker сначала фиксирует состояние в outbox, затем отправляет сообщение и продвигает состояние подписки. Отдельные очереди не позволяют временной ошибке Telegram повторно запрашивать Noon.
