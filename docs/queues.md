# Очереди Noon Tracker

## Назначение

Фоновые задачи реализованы через BullMQ, а их оперативное состояние хранится в Redis. Очереди разделяют получение данных Noon и отправку Telegram-сообщений: сбой Telegram не вызывает повторный запрос каталога, а сбой Noon не блокирует интерфейс бота.

Подключение BullMQ регистрируется глобально в `InfrastructureModule` через `REDIS_HOST`, `REDIS_PORT`, `REDIS_DB`, `REDIS_USERNAME` и `REDIS_PASSWORD`.

## Очередь `product-monitoring`

Job name: `monitor-product`.

Payload:

```ts
interface MonitorProductJobData {
  sku: string;
}
```

### Планирование

`QueuesService.enqueueActiveProducts()` запускается по `OFFERS_CRON`, по умолчанию каждую минуту:

```cron
* * * * *
```

Планировщик:

1. Загружает активные подписки.
2. Получает уникальный набор SKU.
3. Для каждого SKU создаёт один job на текущий минутный bucket.
4. Сохраняет audit record в `queue_executions`.

Формат ID:

```text
monitor-{sku}-{floor(timestamp / 60000)}
```

Одинаковый `jobId` не позволяет нескольким подписчикам или повторному вызову cron создать несколько независимых проверок одного SKU в одну минуту.

### Worker

`MonitoringProcessor` настроен следующим образом:

- concurrency: `2`;
- limiter: максимум `10` jobs за `60 000 ms`;
- attempts: `MONITORING_JOB_ATTEMPTS`, по умолчанию `3`;
- exponential backoff: `MONITORING_JOB_BACKOFF_MS`, по умолчанию `5000 ms`.

Worker проверяет job name, записывает статус `running`, вызывает `MonitoringService.monitorSku(sku)` и завершает audit статусом `completed` или `failed`.

Completed jobs сохраняются ограниченное время: максимум 1000 записей или один час. Failed jobs — максимум 5000 записей или сутки.

## Очередь `telegram-notifications`

Job name: `send-notification`.

Payload BullMQ намеренно минимален:

```ts
interface SendNotificationJobData {
  eventId: string;
}
```

Полезная нагрузка хранится в MongoDB `notification_events`. Это позволяет восстановить отправку независимо от жизненного цикла Redis job.

Поддерживаются события:

- `leader-changed` — сменился `offerId` лидера;
- `target-price` — доступный оффер стал равен целевой цене или дешевле.

### Публикация

`NotificationQueuePublisher.publish()`:

1. Делает upsert события по уникальному `eventId`.
2. Не публикует событие со статусом `sent` или `sending` повторно.
3. Проверяет существующий BullMQ job.
4. Повторно запускает failed job либо создаёт новый с `jobId=eventId`.

Настройки:

- attempts: `NOTIFICATION_JOB_ATTEMPTS`, по умолчанию `5`;
- exponential backoff: `NOTIFICATION_JOB_BACKOFF_MS`, по умолчанию `3000 ms`;
- concurrency notification worker: `5`.

### Обработка

`NotificationProcessor` читает событие из MongoDB:

- `sent` — завершает job без повторной отправки;
- `queued`/`failed` — атомарно переводит запись в `sending`;
- после успеха обновляет подписку и ставит `sent`;
- после ошибки ставит `failed`, сохраняет причину и пробрасывает исключение BullMQ.

Для события смены лидера обновляются `lastLeaderOfferId`, имя продавца и `leaderChangeVersion`. Для целевой цены устанавливается `targetPriceTriggered=true`.

## Идемпотентные ID событий

Смена лидера:

```text
leader-{subscriptionId}-{nextLeaderVersion}-{leaderOfferId}
```

Целевая цена:

```text
target-{subscriptionId}-{targetPriceCycle}-{targetPriceMinor}
```

ID включает доменную версию/цикл, поэтому retry того же события не создаёт дубликат, а новое реальное пересечение порога создаёт новый ID.

## Поведение при ошибках

### Ошибка Noon или proxy

Monitoring job падает и повторяется с backoff. Сохранённый снимок товара не очищается. `ECONNREFUSED` означает недоступный proxy port, `ECONNABORTED` — timeout; обновление cookies само по себе такие ошибки не исправляет.

### Ошибка Telegram

Notification event получает `failed`, а notification job повторяется. Monitoring job уже завершён и не выполняет новый запрос к Noon ради повторной доставки сообщения.

### Повторный запуск worker

Worker сверяет MongoDB event state. Устойчивые IDs и unique constraints делают повторную обработку безопасной в штатных retry-сценариях.

### Lock errors

Сообщения `could not renew lock` или `Missing lock` возможны, когда job выполняется дольше lock duration, event loop задержан или Redis был временно недоступен. В истории проекта они появлялись на фоне 30-секундных proxy timeouts и накопившихся retries. Следует искать первичную сетевую ошибку, а не увеличивать concurrency.

## Наблюдаемость

Основные логи:

```text
Enqueued N unique active SKUs
Noon request failed sku=... attempt=...
Monitoring worker error: ...
Queue audit write failed jobId=...
Notification worker error: ...
```

Для просмотра состояния используются:

- Redis/BullMQ — waiting, active, delayed, completed и failed jobs;
- `queue_executions` — аудит monitoring jobs;
- `notification_events` — состояние доставки сообщений;
- Docker Compose logs — совмещённые runtime-логи.

## Очистка и shutdown

Для очередей включён `forceDisconnectOnShutdown`, а NestJS запускается с `enableShutdownHooks()`. Политики `removeOnComplete` и `removeOnFail` ограничивают рост Redis.

При штатной эксплуатации нельзя вручную удалять active jobs без понимания их MongoDB state. После массового сетевого сбоя очередь может некоторое время обрабатывать накопленные retries — это ожидаемо.
