# База данных Noon Tracker

## Назначение и подключение

Проект использует MongoDB через Mongoose. Подключение регистрируется глобально в `InfrastructureModule` и настраивается переменной `MONGODB_URI`.

```env
MONGODB_URI=mongodb://mongodb:27017/noon-tracker
```

MongoDB хранит долгоживущее состояние приложения. Redis не заменяет базу: он хранит BullMQ jobs, locks и retry state, а MongoDB — подписки, последние успешные снимки, аудит и notification outbox.

## Рабочие коллекции

### `tracking_subscriptions`

Пользовательские подписки на товары.

| Поле                   | Тип         | Назначение                                         |
| ---------------------- | ----------- | -------------------------------------------------- |
| `telegramUserId`       | string      | Telegram user ID                                   |
| `chatId`               | string      | Чат для уведомлений                                |
| `sku`                  | string      | Канонический ID товара                             |
| `canonicalUrl`         | string      | URL без tracking parameters                        |
| `title`                | string/null | Название товара                                    |
| `targetPriceMinor`     | number/null | Целевая цена в филсах                              |
| `isActive`             | boolean     | Участвует ли подписка в мониторинге                |
| `targetPriceTriggered` | boolean     | Уже отправлено уведомление текущего ценового цикла |
| `lastLeaderOfferId`    | string/null | Последний известный лидер                          |
| `lastLeaderSellerName` | string/null | Имя лидера для текста уведомления                  |
| `leaderChangeVersion`  | number      | Версия событий смены лидера                        |
| `targetPriceCycle`     | number      | Номер перевооружения ценового события              |

Индексы:

- unique `{ telegramUserId, chatId, sku }` — одна подписка пользователя на SKU;
- `{ sku, isActive }` — быстрый поиск активных подписчиков товара.

Повторное добавление того же SKU выполняет upsert и активирует существующую запись. `/stop` устанавливает `isActive=false`, не удаляя историю.

### `monitored_products`

Последний успешно полученный снимок каждого SKU.

| Поле                    | Тип            | Назначение                            |
| ----------------------- | -------------- | ------------------------------------- |
| `sku`                   | string, unique | Ключ товара                           |
| `canonicalUrl`          | string         | Каноническая ссылка                   |
| `title`                 | string/null    | Название                              |
| `availability`          | string         | `available` или `no_available_offers` |
| `offers`                | array          | Нормализованные офферы                |
| `lastSuccessfulCheckAt` | Date           | Время успешного ответа Noon           |

Внутри `offers` хранятся `offerId`, `sellerId`, `sellerName`, `priceMinor`, `listPriceMinor` и `available`.

При сетевой ошибке или несовместимом payload эта коллекция не перезаписывается пустым массивом. Поэтому временный сбой Noon не выглядит как исчезновение всех продавцов.

### `queue_executions`

Аудит monitoring jobs.

| Поле          | Тип            | Назначение                                 |
| ------------- | -------------- | ------------------------------------------ |
| `jobId`       | string, unique | BullMQ job ID                              |
| `queue`       | string         | Имя очереди                                |
| `jobName`     | string         | Тип job                                    |
| `sku`         | string         | Обрабатываемый товар                       |
| `status`      | enum           | `queued`, `running`, `completed`, `failed` |
| `attempt`     | number         | Текущая попытка                            |
| `lastError`   | string/null    | Последняя ошибка, максимум 1000 символов   |
| `completedAt` | Date/null      | Время успеха                               |

Ошибка записи аудита логируется, но не должна скрывать исходную ошибку worker.

### `notification_events`

Durable outbox для Telegram-уведомлений.

| Поле             | Тип            | Назначение                            |
| ---------------- | -------------- | ------------------------------------- |
| `eventId`        | string, unique | Идемпотентный ID события              |
| `subscriptionId` | string         | Связанная подписка                    |
| `type`           | enum           | `leader-changed` или `target-price`   |
| `payload`        | Mixed          | Типизированная нагрузка уведомления   |
| `status`         | enum           | `queued`, `sending`, `sent`, `failed` |
| `attempts`       | number         | Число попыток отправки                |
| `lastError`      | string/null    | Последняя ошибка Telegram             |
| `sentAt`         | Date/null      | Время доставки                        |

Уникальный `eventId` предотвращает повторное создание одного события. Этот же ID используется как BullMQ `jobId`.

## Денежные значения

Цены хранятся целыми филсами, а не `number` с дробной частью:

```text
AED 949.00 → 94900
AED 899.99 → 89999
```

Это исключает ошибки сравнения floating point. Значение `targetPriceMinor=null` означает, что пользователь не установил целевую цену.

## Состояние ценового порога

`targetPriceTriggered=false` означает, что подписка готова создать событие. Когда доступный оффер становится `<= targetPriceMinor`, уведомление отправляется и флаг становится `true`. Пока цена остаётся ниже порога, дубликаты не создаются.

Когда цена снова становится выше порога, `rearmTargetPrice()` возвращает флаг в `false` и увеличивает `targetPriceCycle`. Следующее пересечение вниз получит новый устойчивый `eventId`.

## Согласованность и идемпотентность

Проект использует unique indexes, условные updates и устойчивые IDs вместо распределённой транзакции MongoDB + Redis + Telegram. Это практичный вариант для текущего масштаба:

- monitoring job уникален для SKU и минуты;
- notification event создаётся через upsert;
- worker не отправляет событие со статусом `sent` повторно;
- состояние подписки продвигается после отправки;
- failed event сохраняется и повторяется очередью.

MongoDB и Redis не участвуют в одной ACID-транзакции. Поэтому именно idempotent operations обеспечивают корректное повторное выполнение.

## Эксплуатация и безопасность

Локальные сообщения MongoDB `Connection not authenticating` создаются healthcheck-командой `mongosh` и означают, что authentication не настроен, а не ошибку входа. Для локальной разработки база опубликована только на `127.0.0.1`.

В production следует:

- включить MongoDB authentication;
- хранить credentials только в secrets/environment;
- не публиковать MongoDB port наружу;
- настроить backups и retention;
- контролировать рост `queue_executions` и `notification_events`;
- периодически проверять unique indexes.
