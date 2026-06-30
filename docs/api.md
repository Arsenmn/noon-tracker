# API и получение данных Noon

## Назначение

Приложение получает сведения о товаре и его продавцах из внутреннего catalog API Noon UAE. Внешний JSON не используется напрямую в бизнес-логике: сначала он проверяется и преобразуется во внутренний `NoonProductSnapshot`.

Основные файлы:

- `src/noon/noon.controller.ts` — HTTP endpoint приложения;
- `src/noon/noon-url.ts` — проверка ссылки и выделение SKU;
- `src/noon/services/noon-session.service.ts` — browser session, cookies и User-Agent;
- `src/noon/services/noon-client.service.ts` — Axios-запрос к Noon;
- `src/noon/noon-payload.parser.ts` — runtime-валидация ответа;
- `src/noon/noon.types.ts` — внутренняя модель данных.

## HTTP endpoint приложения

### `POST /noon/extract`

Endpoint предназначен для получения нормализованного снимка товара по публичной ссылке Noon.

Запрос:

```json
{
  "url": "https://www.noon.com/uae-en/product-slug/N70164931V/p/"
}
```

Успешный ответ имеет следующий смысловой формат:

```json
{
  "sku": "N70164931V",
  "title": "Название товара",
  "canonicalUrl": "https://www.noon.com/uae-en/product-slug/N70164931V/p/",
  "fetchedAt": "2026-06-30T10:00:00.000Z",
  "context": {
    "country": "ae",
    "locale": "en-ae",
    "zoneCode": "AE_DXB-S14",
    "currency": "AED"
  },
  "availability": "available",
  "offers": [
    {
      "offerId": "offer-code",
      "sellerId": "partner-code",
      "sellerName": "Seller",
      "priceMinor": 94900,
      "listPriceMinor": 99900,
      "available": true
    }
  ]
}
```

`priceMinor` и `listPriceMinor` выражены в филсах. Например, `94900` означает `AED 949.00`.

## Как строится запрос к Noon

Из публичной ссылки вида:

```text
https://www.noon.com/uae-en/{slug}/{SKU}/p/?o={offerCode}
```

формируется запрос:

```text
GET https://www.noon.com/_vs/nc/mp-customer-catalog-api/api/v3/u/{slug}/{SKU}/p/?o={offerCode}
```

Параметр `o` передаётся только тогда, когда он присутствовал в исходной ссылке. Tracking-параметры вроде `utm_source` в канонический URL и идентичность товара не входят.

Перед запросом проверяется:

- протокол `https`;
- домен `noon.com` или `www.noon.com`;
- UAE English section `uae-en`;
- структура product URL;
- допустимый формат SKU.

## Заголовки запроса

Axios получает сессию из `NoonSessionService` и отправляет:

```text
Cookie: <cookies browser context>
User-Agent: <browser user-agent>
Referer: <canonical product URL>
x-mp-country: ae
x-locale: en-ae
x-ecom-zonecode: AE_DXB-S14
```

Если удалось перехватить настоящий catalog request страницы, дополнительно пересылаются разрешённые browser headers: `accept`, `accept-language`, client hints, fetch metadata и некоторые региональные `x-*` headers. `Host`, `Content-Length`, proxy credentials и другие опасные hop-by-hop headers не копируются.

Delivery context должен оставаться одинаковым между проверками, иначе Noon может показать другой набор продавцов или другую доступность.

## Получение cookies и User-Agent

Алгоритм `getSession()`:

1. Проверяет кеш сессии.
2. Если кеш жив, возвращает его без запуска Chromium.
3. Если обновление уже выполняется, другие вызовы ожидают общий `refreshPromise`.
4. При первом обращении лениво запускает persistent Chromium context через Playwright Extra и stealth plugin.
5. Если настроен `PROXY_URL`, браузер по умолчанию использует тот же proxy, что и Axios.
6. Определяет browser User-Agent и заменяет маркер `HeadlessChrome` на `Chrome` до навигации.
7. До `page.goto()` подписывается на реальный GET catalog request.
8. Открывает страницу с `waitUntil: 'commit'`, чтобы не зависеть от долгой загрузки всех ресурсов.
9. При успешном перехвате читает `request.allHeaders()`.
10. Если request не появился в течение уже настроенного settle window, использует безопасный fallback: `context.cookies(productUrl)` и browser User-Agent.
11. Сохраняет HTTP-сессию в памяти, а browser context и одну страницу переиспользует для следующих refresh.
12. Закрывает Chromium при shutdown приложения либо после `NOON_BROWSER_IDLE_MS` бездействия.

Отсутствие перехваченного catalog request само по себе не является ошибкой. Страница может не выполнить этот запрос из-за варианта frontend, кеша, anti-bot ответа или неполной загрузки. В этом случае достаточно cookies из browser context, если последующий Axios-запрос принимается Noon.

## Срок жизни сессии

Сессия действует до наиболее раннего срока:

- `Date.now() + NOON_COOKIE_REFRESH_MS`;
- минимальный `expires` постоянного cookie минус `NOON_COOKIE_EXPIRY_SKEW_MS`.

Cookies с `expires <= 0` считаются session cookies; для них используется общий TTL. Safety skew обновляет сессию немного заранее. По умолчанию TTL равен четырём минутам, skew — 30 секундам.

При HTTP `401`, `403`, `429` или `503` кеш инвалидируется, переиспользуемый Chromium обновляет browser state, а Axios выполняет ещё одну попытку. Сетевые ошибки proxy вроде `ECONNREFUSED` и `ECONNABORTED` не являются ошибкой cookies: запрос в таком случае не дошёл до Noon и повторяется уже механизмом BullMQ.

Такой lifecycle убирает запуск процесса Chromium каждые несколько минут и отдельное десятисекундное ожидание `waitForRequest`. При этом idle timer освобождает память браузера, когда мониторинг фактически не использует сессию.

## Нормализация ответа

`parseNoonCatalogPayload()` принимает `unknown` и проверяет обязательные поля во время выполнения. Для каждого оффера сохраняются:

- `offer_code` → `offerId`;
- `partner_code` → `sellerId`;
- `store_name` → `sellerName`;
- `is_buyable` → `available`;
- `price` → `listPriceMinor`;
- `sale_price ?? price` → `priceMinor`.

Цена разбирается из десятичной строки без бинарных floating-point вычислений. Неполный или несовместимый payload приводит к `BadGatewayException`, а не к ложному состоянию «продавцов нет».

После парсинга выбирается вариант, соответствующий SKU или offer code из URL. Офферы сортируются по `priceMinor`, затем по `offerId` для детерминированного результата.

## Ошибки и диагностика

- Неверная ссылка: `BadRequestException`.
- Noon или proxy недоступен: `ServiceUnavailableException`.
- Noon вернул несовместимый JSON: `BadGatewayException`.
- Browser session не содержит cookies: `ServiceUnavailableException`.

Диагностические логи содержат SKU, attempt, тип ошибки, источник сессии, User-Agent, имена cookies, длину Cookie header, keys пересылаемых headers и TTL. Полные cookie values и proxy credentials логировать нельзя.

Fixtures в `src/noon/fixtures` позволяют тестировать parser и клиент без живого Noon.

## Почему данные было трудно получить — заметка по истории проекта

Главная сложность была не в Axios и не в JSON parser. Когда использовались вручную скопированные рабочие `Cookie` и `User-Agent`, тот же Axios возвращал корректный catalog payload. Это доказало, что endpoint и структура запроса найдены правильно, а проблема находится в создании эквивалентной browser session.

Noon использует несколько связанных защитных механизмов:

- anti-bot cookies выдаются только после browser navigation;
- набор cookies меняется со временем и содержит короткоживущие значения;
- сессия связана с User-Agent и, на практике, с сетевым адресом;
- headless Chromium изначально сообщал `HeadlessChrome`, что отличало его от обычного браузера;
- frontend не гарантирует выполнение catalog request при каждом открытии страницы;
- proxy периодически отвечал `ECONNREFUSED` или зависал до timeout;
- браузер сначала выходил напрямую, а Axios — через proxy, поэтому IP-контекст сессии не совпадал;
- старый Docker image некоторое время продолжал работать без новых логов, хотя исходники на host уже были исправлены.

Рабочее решение появилось после разделения этих проблем. Сначала реальный браузер создаёт допустимый контекст и получает cookies. Playwright начинает слушать catalog request до навигации и, если request появляется, забирает headers через `allHeaders()`. Поскольку request появляется не всегда, предусмотрен fallback на `context.cookies()`. User-Agent берётся из Chromium и нормализуется, а browser и Axios обязательно используют один proxy. Сессия кешируется до истечения cookies и принудительно обновляется после anti-bot HTTP statuses.

Это не взлом и не отключение защиты Noon: приложение воспроизводит обычную browser session и затем использует её для обращения к публично вызываемому frontend API. Ключевой практический вывод из всех наших сессий: cookies, User-Agent, delivery headers и исходящий IP нужно рассматривать как единый контекст. Исправление только одного элемента не работает. Также нельзя диагностировать cookies по `ECONNREFUSED`: такая ошибка означает, что соединение с proxy не установлено ещё до обращения к сайту.
