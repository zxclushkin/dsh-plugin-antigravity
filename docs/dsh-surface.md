# DSH 0.2.1-rc.5: максимальная поверхность для нативного адаптера Google/Antigravity

Разведка от 2026-11-05, второй заход. Приоритет изменён: плагин `dsh-plugin-antigravity v0.2`
делается **родным Cordis-плагином с нативным `LlmAdapter`** (`inject:['llm']`, `ctx.llm.registerAdapter(['antigravity'], adapter)`) —
без локального HTTP-шлюза и без маршрута в `llm-pi-ai`. Поэтому раздел 1 (контракт адаптера) — главный.
Всё ниже — read-only разведка по установленным пакетам; профиль и плагин не менялись.

Обозначения: `$ASAR` = `C:\Users\zxclu\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`,
`$PKG` = `$ASAR\dsh\node_modules\@deepseek-ai`.

Артефакты: `C:\lab\antigravity\research\dsh\` (`asar-cat.js` — read-only чтение файлов из `app.asar`,
`live-config-schema-llm-pi-ai.json`, `live-service-catalog.txt`, `dump-config-*.txt`).

---

## 0. TL;DR

1. Нативному адаптеру (как **plain-объекту**) нужны **6 методов**: `providerInfo`, `providerRetryPolicy`,
   `listModels`, `resolveModel`, `prepareCall` (+ `stream` внутри возврата `prepareCall`); `imageRequestTarget` —
   если работаете с картинками. `providerRetryPolicy` и `prepareCall` вызываются **безусловно** — без них
   регистрация/каждый запрос падают (подробности §1.1). Регистрация — синхронная, в `apply`, через
   `ctx.llm.registerAdapter(['antigravity'], adapter)`.
2. `stream()` — async-генератор `StreamChunk`-ов: `block-start` / `text-delta` / `reasoning-delta` / `tool-call-delta` /
   `block-end` / `usage` / `finish`; **ровно один** терминальный `finish`. Рассуждения — только `reasoning-delta`
   (в UI это блок «Thinking»); изображений в стриме нет.
3. `resolveModel` возвращает `{provider,id,name,inputModalities,context:{contextWindow},defaultMaxTokens,reasoning:{efforts:[{id,name}],defaultEffort}}` —
   именно отсюда пикер берёт модели и уровни effort. Ошибка в этом объекте = провайдер не появится в пикере.
4. DSH **сам** проецирует файлы в текст и картинки в текст для text-only моделей; адаптер получает уже готовые messages.
5. UI отрисует: markdown текста (включая **code-блоки, таблицы, ссылки и картинки по абсолютному пути**),
   раскрывающийся reasoning, tool-call строки. **Не отрисует**: citations/annotations, audio, произвольные поля.
6. Сгенерированную картинку показывать **markdown-текстом с абсолютным путём** (`![](C:/.../out.png)`) — рендерится
   через аутентифицированный `api/file`; ассистентский image-блок технически возможен, но это «forward compatibility».
7. `response_format`/`json_schema` в DSH **нет вообще** — структурированный вывод не является поверхностью DSH;
   вместо него — либо tool-calling, либо фиксированная схема внутри адаптера.
8. Маршрут `antigravity` из `llm-pi-ai` надо **удалить** при переходе на нативный адаптер, иначе `DUPLICATE_ADAPTER`.

---

## 1. НАТИВНЫЙ АДАПТЕР: полный контракт

### 1.1 Регистрация и требования

```js
// $PKG/dsh-llm/lib/index.js:1842-1861
registerAdapter(providers, adapter) // -> { (): void, replace(next: string[]): void }
```

* `providers` — массив непустых строк-маршрутов (`['antigravity']`). Регистрация **all-or-nothing**:
  любой конфликт → `LlmError`, ничего не регистрируется.
* Для каждого маршрута вызывается `adapter.providerInfo(provider)`; валидация (`:1867-1887`):
  `info.id === provider` (строка), `typeof info.name === 'string' && info.name.length > 0`,
  иначе `LlmError("adapter metadata for provider … must preserve its id and have a non-empty name", "INVALID_ADAPTER")`.
* Повторная регистрация уже занятого маршрута (в т.ч. вторым экземпляром плагина или `llm-pi-ai`) →
  `LlmError(… "DUPLICATE_ADAPTER")` (`:1872`).
* `adapter.providerRetryPolicy(provider)` вызывается **безусловно** при регистрации (`:1876`):
  `const retryPolicy = adapter.providerRetryPolicy(provider) ?? resolveRetryPolicy(void 0, …)`.
  У класса `LlmAdapter` есть дефолт, у plain-объекта — **нет**: отсутствие метода = `TypeError` на регистрации.
  Возвращайте `undefined` → политика по умолчанию (`normal`, 5 ретраев). Ретраи исполняет `dsh-llm-retry`.
* `adapter.prepareCall(provider, model, signal)` вызывается **безусловно** в двух местах: в `llm.prepareCall()`
  (`:2224`) и в `adapterStream` (`:2318`). Отсутствие метода = каждый запрос падает (ошибка уходит в
  терминальный failure-чанк). Дефолт (`:1749-1753`) есть только у базового класса:
  `{model: await this.resolveModel(...), stream: (o) => this.stream(o)}` — его и надо повторить.
* `adapter.imageRequestTarget(provider, model, image)` вызывается рантаймом при проекции картинок
  (`:2063-2065`, безусловно) — реализуйте тривиальный дефолт
  `(_p,_m,img) => ({width: img.width, height: img.height, maxBytes: img.bytes})`, если принимаете изображения.
  `adapter.imageRequestPricing` — опционален (вызов через `?.`, `:2053-2055`).
* Регистрация живёт на фибере плагина: `registerAdapter` внутри делает `this.ctx.effect(...)` (`:1845-1854`),
  поэтому вызывать её надо из `apply` (или внутри `ctx.effect`), и ничего диспозить вручную не нужно.

Требования к плагину: `inject: ['llm']`, экспорт `apply` (и, по желанию, `name`/`Config`).
`Config` **не обязателен**. Класс `LlmAdapter` наследовать не обязательно — рантайм работает duck-typed,
используя только перечисленные методы.

### 1.2 `listModels(provider)` — каталожные метаданные

Вызывается рантаймом (`$PKG/dsh-llm/lib/index.js:2086-2101`) и **строго валидируется**:

```ts
listModels(provider: string): Promise<Array<{
  provider: string;      // ДОЛЖЕН совпадать с маршрутом
  id: string;            // непустой, уникальный
  name: string;          // непустой
  description?: string;
  inputModalities?: Array<'text'|'image'|…>;   // именно это имя
}>>;
```

Нарушение → `LlmError(… "INVALID_CATALOG")`. Пустой массив допустим, но тогда группы в пикере нет.

### 1.3 `resolveModel(provider, model, signal)` — точные метаданные модели

Вызывается перед каждым вызовом и **на каждую модель пикера**. Валидатор —
`normalizeModelInfo` (`$PKG/dsh-llm/lib/index.js:2119-2163`). Точный shape:

```ts
resolveModel(provider, model, signal) => Promise<{
  provider: string;            // === provider, иначе INVALID_MODEL_INFO
  id: string;                  // === model,    иначе INVALID_MODEL_INFO
  name: string;                // непустой
  description?: string;
  inputModalities?: Array<'text'|'image'>;      // ['text','image'] => картинки доходят до адаптера
  context?: { contextWindow: number };          // целое > 0, иначе INVALID_MODEL_CONTEXT
  defaultMaxTokens?: number;                    // целое > 0, иначе INVALID_MODEL_MAX_TOKENS
  systemPromptUpdate?: 'in-history';
  toolUpdate?: 'in-history' | 'addition-only';
  reasoning?: {
    efforts: Array<{ id: string; name: string; description?: string }>;  // непустой, id уникальны
    defaultEffort?: string;                     // обязан быть среди efforts
  };
}>
```

Ошибки: `INVALID_MODEL_INFO`, `INVALID_MODEL_CONTEXT`, `INVALID_MODEL_MAX_TOKENS`,
`INVALID_MODEL_REASONING` (пустой `efforts` или `defaultEffort` вне списка).
`systemPromptUpdate: 'in-history'` означает «модель читает `system` в любой позиции истории»
(адаптер сам решает, как это сериализовать); `toolUpdate` — поддержка mid-conversation
`tool-addition`/`tool-removal` (`in-history` = полные объявления + блоки, `addition-only` = только активные
объявления). **Если сомневаетесь — не задавайте оба поля**: рантайм тогда вырежет developer-сообщения
с правками инструментов и отдаст полный текущий список (`content.js:290-302`).

### 1.4 `GenerateOptions` — что придёт в `stream()` и `resolveModel()`

Точные поля (сверено по реализациям `dsh-llm-deepseek/lib/index.js:2145-2243` и `dsh-llm-pi-ai/lib/index.js:1269-1294, 1754-1765`):

| Поле | Тип | Смысл |
|---|---|---|
| `provider` | string | маршрут (уже выбранный) |
| `model` | string | id модели как в `listModels` |
| `messages` | `Message[]` | durable история + request-only user inputs |
| `system` | string? | one-shot системный промпт (вместе с ведущими `system`-сообщениями истории) |
| `tools` | `ToolSchema[]?` | активные объявления: `{name, description, parameters(JSON Schema), deferLoading?}`; `deferLoading` отфильтровать |
| `toolChoice` | unknown? | рантайм пробрасывает как есть (адаптер сам решает, что с ним делать) |
| `reasoningEffort` | string? | id из `reasoning.efforts` выбранной модели |
| `maxTokens` | number? | уже материализован из `defaultMaxTokens`, если не задан |
| `temperature` | number? | |
| `stop` | string[]? | |
| `sessionId` | string(brand)? | можно отдавать в заголовке/теле (опционально) |
| `purpose` | `'compaction'`? | признак вспомогательного вызова |
| `signal` | AbortSignal? | обязателен к пробросу в сеть |

Ограничение из README (`$PKG/dsh-llm/README.md:177`): «`GenerateOptions` sampling is `temperature`/`maxTokens`/`stop` only —
no `tool_choice`, `top_p`, or penalty fields». **Никаких `response_format`, `seed`, `top_p`, `parallel_tool_calls` в DSH нет.**

Форматы content-блоков `messages` (то, что реально приходит адаптеру после проекций рантайма):

| Роль | Блоки |
|---|---|
| `system` | `{type:'text', text}` (ведущие сообщения, если есть) |
| `user` | `{type:'text', text}`, `{type:'image', attachment: ImageAttachmentRef, offloaded?: true}` (файлы уже спроецированы в текст, §1.9) |
| `developer` | `{type:'text', text}`, `{type:'tool-addition', toolName}`, `{type:'tool-removal', toolName}` — **только если** `toolUpdate` задан; иначе вырезаются |
| `assistant` | `{type:'text', text}`, `{type:'reasoning', text}`, `{type:'tool-call', id, name, arguments: <JSON-строка>}` |
| `tool` | `content: [{type:'text', text}, {type:'image', …}]`, плюс `toolCallId` |

Это подтверждается обработкой в `dsh-llm-pi-ai/lib/index.js:1220-1240` (user/system), `1300-1317` (developer),
`148-171` (assistant), `1064-1124` (tool result: текст + картинки отдельным user-сообщением).

### 1.5 `stream(options)` — протокол `StreamChunk`

`stream` возвращает `AsyncIterable<StreamChunk>`; рантайм берёт `[Symbol.asyncIterator]()`
(`$PKG/dsh-llm/lib/index.js:2349`). Ассемблер `BlockAssembler` (`:964-1005`) задаёт **полный** словарь чанков:

| Чанк | Поля | Правила |
|---|---|---|
| `block-start` | `{type:'block-start', index:number, blockType:'text'|'reasoning'|'tool-call'}` | опционален: дельты без него создают блок сами |
| `text-delta` | `{type, index, text:string}` | накапливается в блок `text` |
| `reasoning-delta` | `{type, index, text:string}` | накапливается в блок `reasoning` (UI: «Thinking») |
| `tool-call-delta` | `{type, index, id:string, name?:string, argumentsDelta:string}` | `argumentsDelta` — **кусок JSON-строки**; может быть пустым (первый) |
| `block-end` | `{type, index, block: ContentBlock}` | финальный блок: `{type:'text',text}` \| `{type:'reasoning',text}` \| `{type:'tool-call',id,name,arguments:<JSON-строка>}` |
| `usage` | `{type, usage:{inputTokens, outputTokens, totalTokens, cacheReadTokens?, cacheWriteTokens?}}` | ровно один, перед `finish` |
| `finish` | `{type, reason: FinishReason, replayState?: unknown}` | ровно один, последний |

`FinishReason` (используемые рантаймом виды): `{kind:'stop'}` | `{kind:'tool-calls'}` | `{kind:'max-tokens'}` |
`{kind:'error', failure}` | `{kind:'aborted', failure}`; дефолт, если не пришёл, — `{kind:'stop'}` (`:1102`).

Семантика, которую обеспечивает ассемблер (`:1007-1038`):
* `block-end` **не обязателен**: если его нет, блок собирается из дельт (`text` / `reasoning` / `tool-call`, где
  `arguments` = конкатенация `argumentsDelta`). Дельты для уже закрытого индекса игнорируются.
* Если `block-end` пришёл, его `block` используется как есть (`assemble: partial.block`) — это единственный способ
  отдать блок не из трёх базовых типов (см. §2.4, image-блок).
* `tool-call.arguments` обязан быть **строкой JSON** (а не объектом) — так его ждёт и loop, и история
  (сравните: `dsh-llm-deepseek` делает `JSON.stringify(object(native.input))`, `:1873`).
* `max-tokens` → блоки tool-call **отбрасываются** ассемблером (`:1053`), учитывайте это.
* `usage` обязателен для показа статистики (§2.7): без него скрывается per-turn usage.

### 1.6 `usage` и `replayState`

`usage` → `mapUsage` (`dsh-llm-pi-ai/lib/index.js:1439-1447` — эталон):

```js
{ inputTokens: usage.input, outputTokens: usage.output, totalTokens: usage.totalTokens,
  ...(cacheRead>0?{cacheReadTokens:cacheRead}:{}), ...(cacheWrite>0?{cacheWriteTokens:cacheWrite}:{}) }
```

`totalTokens` передаётся ровно как есть. **Кэш-хиты** показываются в composer-статистике и в per-turn usage
как `cacheReadTokens` (см. §2.7).

`finish.replayState` — **произвольное JSON-значение, целиком принадлежащее адаптеру**: ассемблер кладёт его
в `assistant.message.source.replayState` (`:1002`, `:1109`), а на следующем ходе адаптер видит его в
`messages[i].source.replayState` для своих же ответов. Валидирует его только сам адаптер
(эталон: `llm-pi-ai/lib/index.js:61-142` — конверт `{provider, model, api, blocks:[{type, …signatures}]}`).

Это **штатный канал** для `thoughtSignature` Gemini: не надо прятать подпись в `tool_call.id` (как делает
HTTP-шлюз v0.1) — положите её в `replayState` и восстанавливайте при сериализации истории.

### 1.7 Ошибки, отмена, ретраи

* Бросьте `LlmError(message, code, {cause, status, providerRetryAfterMs, requestId})` (или его аналог —
  см. §1.11) из async-генератора: рантайм обернёт это в терминальный чанк
  `{type:'finish', reason:{kind:'error'|'aborted', failure}}` (`:2401-2414`), при этом `signal.aborted`
  или `code==='ABORTED'` даёт `kind:'aborted'`.
* Коды, на которые смотрит агент/ретрай: `AUTH`, `RATE_LIMIT`, `QUOTA`, `ACCOUNT_QUOTA`,
  `CONTEXT_WINDOW_EXCEEDED`, `TIMEOUT`, `TRANSPORT`, `INVALID_REQUEST`, `EMPTY_RESPONSE`, `ABORTED`
  (`README.md:91-97`, константы экспортируются из `@deepseek-ai/dsh-llm`).
* Отмена: пробрасывайте `options.signal` в `fetch`; `AbortError` → `kind:'aborted'`.
* **Ретраи внутри адаптера не делать** — «This service never re-runs a request: retrying is the job of
  `dsh-llm-retry`» (`README.md:97`); политика берётся из `providerRetryPolicy(provider)` при регистрации.
* Если ассемблер не получил ни одного терминального чанка, а поток закончился — ошибка не поднимется
  (loop увидит finish по умолчанию `stop`), поэтому `usage`+`finish` надо эмитить всегда.
* `prepareCall` **обязательно реализовать**, если адаптер — plain-объект (у класса `LlmAdapter` дефолт
  `$PKG/dsh-llm/lib/index.js:1749-1753` = `{model: await this.resolveModel(...), stream: (o) => this.stream(o)}`;
  рантайм вызывает `adapter.prepareCall` безусловно — `:2224`, `:2318`).

### 1.8 Что рантайм делает ЗА адаптера (до вызова `stream`)

`adapterStream` (`$PKG/dsh-llm/lib/index.js:2309-2349`):

1. `prepareCall` → `normalizeModelInfo` → `resolveCallWithInfo` (валидирует `reasoningEffort` против
   `efforts`, материализует `maxTokens` из `defaultMaxTokens`, подставляет `temperature`/`stop`);
2. `messages` с блоками `file` → `projectFilesToText(messages, fileReadPath)` (файл становится текстом-хэндлом, §3.2);
3. если `inputModalities` не содержит `image` → `projectImagesForTextModel` (картинки → текст-заглушки);
4. `projectToolUpdates(messages, tools, modelInfo.toolUpdate, options.toolHistory)` — developer-сообщения
   с `tool-addition`/`tool-removal` либо остаются, либо вырезаются (+ фильтр `deferLoading`);
5. `dispatch(projectedOptions)`; исключения → терминальный failure-чанк; закрытие итератора при раннем выходе.

**Следствие:** адаптеру не нужно обрабатывать `file`-блоки и не нужно чистить developer-сообщения в базовом
случае — но `image`-блоки он получит сам и обязан их отправить (или явно отказать `UNSUPPORTED_CONTENT`).

### 1.9 Эталон: как `dsh-llm-pi-ai` делает `resolveModel`/`listModels`/`stream`

* `listModels` — `lib/index.js:1887-1904`: `Promise.resolve().then(...)`, возвращает
  `{provider, id, name, inputModalities:[...model.input]}`; при неразрешимом креденшеле возвращает `[]`.
* `resolveModel` — `:1905-1940` (`modelInfo`): `{provider, id, name, description?, inputModalities,
  context:{contextWindow}, defaultMaxTokens, reasoning:{efforts, defaultEffort}}`; `efforts` строятся как
  `{id: ReasoningEffortId(level), name: Capitalized(level)}` (`:1808-1814`).
* `stream` — `:1880-2010` (`PiAiAdapter.stream`) → `toStreamChunks` (`:1537-1653`): именно оттуда взяты
  таблицы §1.5/§1.6 (`block-start`→`text-delta`→…→`block-end`→`usage`→`finish`).

### 1.10 Минимальный рабочий скелет (zero-import, монтируется абсолютным путём)

Критично: если плагин монтируется **абсолютным путём** (`name: 'C:/lab/antigravity/plugin/index.mjs'`, как сейчас),
`import '@deepseek-ai/dsh-llm'` из него **не разрешится** — файл лежит вне профиля и его `node_modules`-дерева.
Поэтому скелет ниже не импортирует ничего из DSH: адаптер duck-typed, ошибки — `Error` с собственными
`code`/`failure` (их читает `normalizeLlmFailure`, `:402-414` + `ownFailureSnapshot`, `:430-460`).

```js
// language: JavaScript (ESM), file: plugin/index.mjs, runtime: DSH host (Node 24)
// Native DSH LLM adapter for Antigravity. No HTTP gateway, no llm-pi-ai route.
export const name = 'antigravity-llm'
export const inject = ['llm']

/** Wire models this adapter advertises; replace with the real catalogue. */
const MODELS = [
  { id: 'gemini-3-flash', name: 'Gemini 3 Flash', contextWindow: 1_048_576, maxTokens: 65_536,
    inputModalities: ['text', 'image'] },
]

/** Plain-Error variant of LlmError that the harness still maps to a stable failure code. */
function fail(message, code, extra = {}) {
  const error = new Error(message)
  error.code = code
  error.failure = { message, code, ...extra }
  return error
}

/** One assistant turn; replace the body with the Antigravity SSE call. */
async function* turn(options) {
  // options.signal — обязателен к пробросу в fetch
  const text = 'Antigravity adapter stub: no upstream call yet.'
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }
  yield { type: 'finish', reason: { kind: 'stop' }, replayState: { adapter: 'antigravity', version: 1 } }
}

const adapter = {
  providerInfo: (provider) => ({ id: provider, name: 'Antigravity' }),

  // ОБЯЗАТЕЛЕН: вызывается при регистрации безусловно.
  providerRetryPolicy: () => undefined,

  async listModels(provider) {
    return MODELS.map((m) => ({ provider, id: m.id, name: m.name, inputModalities: m.inputModalities }))
  },

  async resolveModel(provider, model) {
    const m = MODELS.find((entry) => entry.id === model)
    if (m === undefined) throw fail(`Antigravity has no model "${model}"`, 'UNKNOWN_MODEL')
    return {
      provider, id: m.id, name: m.name,
      inputModalities: m.inputModalities,
      context: { contextWindow: m.contextWindow },
      defaultMaxTokens: m.maxTokens,
      reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' },
    }
  },

  // ОБЯЗАТЕЛЕН: вызывается безусловно перед каждым запросом.
  async prepareCall(provider, model, signal) {
    const resolved = await adapter.resolveModel(provider, model, signal)
    return { model: resolved, stream: (options) => turn(options) }
  },

  stream: (options) => turn(options),

  imageRequestTarget: (_provider, _model, image) => ({
    width: image.width, height: image.height, maxBytes: image.bytes,
  }),
}

export function apply(ctx) {
  ctx.llm.registerAdapter(['antigravity'], adapter)
  ctx.logger.info('antigravity: native LLM adapter registered')
}
```

**Скелет проверен динамически** (без записи в профиль): блок из этого раздела извлечён из документа, запущен
через `node --input-type=module` с эмуляцией ровно тех вызовов, которые делает `dsh-llm`
(`registerAdapter` → `providerInfo` → `providerRetryPolicy` → `listModels` → `resolveModel` → `prepareCall`
→ итерация `stream`), а результат `resolveModel` прогнан через те же проверки, что и `normalizeModelInfo`.
Вывод проверки:

```text
routes= ["antigravity"] name= Antigravity
listModels[0]= {"provider":"antigravity","id":"gemini-3-flash","name":"Gemini 3 Flash","inputModalities":["text","image"]}
prepareCall.model.id= gemini-3-flash has stream= true
chunks= ["block-start","text-delta","block-end","usage","finish"] finish= {"kind":"stop"} usage= {"inputTokens":0,"outputTokens":0,"totalTokens":0}
OK: skeleton imports, registers, satisfies duck contract and emits a valid chunk stream
```

То есть: ESM-импорт проходит, регистрация не бросает, валидация метаданных и протокола чанков — проходит.
Дальше остаётся только заменить тело `turn()` на реальный вызов Antigravity.

Провижининг в профиле (строку `insert` с `llm-pi-ai`-провайдером `antigravity` надо **удалить** — иначе
`DUPLICATE_ADAPTER`):

```yaml
# $PROFILE\cordis.patch.yml
- insert:
    - id: antigravity-llm
      name: "C:/lab/antigravity/plugin/index.mjs"
      config:
        # любые поля; Config у плагина нет — конфиг просто передадут в apply(ctx, config)
```

Проверка монтирования: `cordis_inspect_query {platform:'host', provider:'Config', method:'listConfigs'}` →
`include:antigravity-llm` со статусом `schema` (или `absent`, если Config-схемы нет), а в логе Host —
`antigravity: native LLM adapter registered`; в Web UI — группа `Antigravity` в селекторе модели.

### 1.11 Альтернатива: `link:`-установка и импорт настоящего `LlmError`

Если плагин ставится в профиль зависимостью (`& $CLI plugin --profile desktop add link:C:\lab\antigravity\plugin`),
то bare-импорты `@deepseek-ai/*` резолвятся из профиля (linked-root peer routing), и можно писать:

```js
import { LlmError, attributionHeaders } from '@deepseek-ai/dsh-llm'
...
headers: { ...attributionHeaders(), 'content-type': 'application/json' }
```

Контракт требует attribution-заголовки в каждом запросе: «Every provider HTTP request must include
`attributionHeaders()`» (`$PKG/dsh-llm/lib/index.js:1664-1668`). Сейчас это только `user-agent`
(`:877-879`, формат `product/version (+url)`, `:867-869`), т.е. при zero-import варианте достаточно
самостоятельно выставить `user-agent: 'deepseek-harness/0.2.1-rc.5 (+https://github.com/deepseek-ai/deepseek-harness)'`.

Плюс `link:`-варианта: HMR следит за linked-target, правки кода подхватываются без рестарта
(`$PKG/dsh-hmr/README.md:49`); минус — нужен pnpm-прогон при каждом изменении состава зависимостей.

---

## 2. Что реально отрисует Web UI

Рендеринг ассистентского ответа — `AssistantMarkdown` (`$PKG\dsh-client-ui-chat\lib\client.js:6290-6364`),
он диспетчеризует **по типу блока** (`data.blocks` из проекции сессии), а не по сырому markdown:

| `block.kind` | Что рендерится | Строки |
|---|---|---|
| `text` | `MarkdownText` — полный markdown (GFM): абзацы, `**`, списки, таблицы, code-блоки с баннером и копированием, ссылки, картинки | `6304-6312` |
| `reasoning` | `ReasoningRow` — раскрывающийся «Thinking» (свёрнут; заголовок — первая строка/последний завершённый абзац, `**` вырезаются; в раскрытом виде — markdown с secondary-типографикой) | `6313-6328`, `6113-6127`, `6187-6230` |
| `image` | слот `conversation.chat.message.images` (нативные изображения сообщения, с `loadImage`) | `6329-6344` |
| `tool-call` | в этом рендере пропускается (строки вызова инструмента рисует отдельный Tool-рендерер) | `6345` |
| прочее | `JsonBlock` «unknown block» | `6346-6350` |

Пустой массив блоков/только tool-call → `AssistantMarkdown` вернёт `null` (`6296`).

### 2.1 Markdown и картинки

* `text`-блок рендерится в `MarkdownText` с `pathImages`, который резолвит **абсолютные локальные пути**
  в аутентифицированный URL `api/file?path=…` (`client.js:6280-6294`, `92-95`):
  ```js
  function fileMediaUrl(base, path) {   // :92-95
    if (!/^https?:/u.test(base) && !base.startsWith('dsh-app://app/') ||
        !isAbsoluteWorkspacePath(path) || /^[/\\]{2}/u.test(path) || /[\u0000-\u001f\u007f]/u.test(path)) return void 0
    return new URL(`api/file?path=${encodeURIComponent(path)}`, base).href
  }
  ```
  `isAbsoluteWorkspacePath` (`:53-55`) = начинается с `/` **или** Windows-путь `C:/`, `C:\`, `\\server`;
  UNC и control-символы отвергаются.
* README (`$PKG\dsh-client-ui-chat\README.md:46`): «Standalone Markdown images show contained previews and open
  the shared image lightbox; local paths resolve against the viewed workspace after settlement».
* `api/file` отдаёт файл по абсолютному пути, и **файлы вне воркспейса разрешены**: «absolute path or path relative
  to the workspace root; files outside it are allowed» (`$PKG\dsh-api-workspace-files\lib\index.js:421`).
  В живой GUI без авторизации `GET /api/file?path=…` отвечает `401` (проверено), т.е. доступ идёт через
  сессионную авторизацию страницы.
* Ссылки (`[text](url)`) рендерятся: HTTP(S) открываются в in-app Sidebar Browser (по умолчанию) или внешне;
  файловые ссылки — в правом Sidebar (`README.md:37-48`).
* Таблицы: широкие таблицы имеют особый скролл-режим `md-table-wide` (CSS `client.js:6253`).

### 2.2 Reasoning («Thinking»)

* Содержимое — **markdown**, но по умолчанию строка свёрнута; заголовок = первая строка (или первый
  завершённый абзац, пока идёт стрим), `**` в заголовке вырезаются (`:6196-6197`).
* Если reasoning-текст начинается с `<signature>…</signature>`, эта обёртка **вырезается из отображаемого**
  текста, но остаётся в durable-сообщении (`reasoningText`, `:6113-6127`). Это второй (после `replayState`)
  канал для подписей/метаданных: модель/пользователь их не увидят, а адаптер прочитает из истории.
* Слот `conversation.chat.reasoning.body` получает `{rawText, text, running}` — сторонний плагин может заменить
  рендер (`README.md:120`).

### 2.3 Изображения в ответе ассистента

Два пути:

**(A) markdown-текст с абсолютным путём — рекомендуется.** Адаптер сохраняет байты картинки в файл
(например `C:\lab\antigravity\generated\<id>.png`) и эмитит в тексте
`![generated image](C:/lab/antigravity/generated/<id>.png)` → UI покажет превью и лайтбокс.
Требования: абсолютный путь (POSIX или `C:/…`), не UNC, без control-символов; `/` предпочтительнее.
Файл должен быть читаем процессом Host на момент рендера.

**(B) ассистентский `image`-блок — «forward compatibility».** Технически возможно:
`yield {type:'block-end', index, block:{type:'image', attachment}}` — ассемблер пропустит блок как есть
(`assemble: partial.block`), UI умеет его рисовать, а контракт вложений это предусматривает структурно:
«the role-neutral `ImageBlock` leaves assistant-side image output as forward compatibility — current
production adapters declare text-only output, so only user content carries images»
(`$PKG\dsh-attachment\README.md:134-136`). Но ни один штатный адаптер так не делает (`llm-pi-ai` прямо
бросает `UNSUPPORTED_CONTENT` на ассистентский image-блок: `lib/index.js:169`), а `attachment` обязан быть
валидным `ImageAttachmentRef` из сервиса вложений. Считайте это экспериментальным и не единственным путём.

### 2.4 Чего UI НЕ отрисует

| Что | Факт |
|---|---|
| citations/annotations (groundingMetadata) | в клиенте чата нет ни одного упоминания `citation`/`annotation` (grep по 595 КБ `ui-chat/lib/client.js` = 0); отдельного UI нет |
| audio (вход/выход) | нет: «audio and video have no dedicated handling yet» (`dsh-attachment\README.md:118`) |
| произвольные блоки | `JsonBlock` «unknown block» (`client.js:6346`) |
| reasoning иначе как текстом | `reasoning`-блок = только текст; структурных «thought parts» нет |
| usage/цена в сообщении | только через per-turn usage row и composer stats (§2.7) |

### 2.5 Итог: как показать сгенерированную картинку

```js
// в stream(): после получения inlineData от Antigravity
const file = path.join('C:/lab/antigravity/generated', `${id}.png`)   // абсолютный путь
await fs.promises.writeFile(file, Buffer.from(base64, 'base64'))
const text = `Готово.\n\n![${id}](${file.replaceAll('\\', '/')})\n`
yield { type: 'text-delta', index, text }  // и block-end с полным текстом
```

Важно: markdown-путь должен быть абсолютным; относительный (`generated/x.png`) ассистентский рендер **не**
резолвит (для ответа используется `localPathMediaUrl` без `cwd`, `client.js:6292-6294`), в отличие от
пользовательских вложений, где путь резолвится от `cwd` сессии (`:2760`).

### 2.6 Usage / токены / кэш

* Per-turn раскрывающаяся строка usage: показывается, **только если** все начатые попытки сообщили корректный
  `usage`; «Incomplete or contradictory accounting hides the complete disclosure instead of presenting a
  partial total» (`$PKG\dsh-client-ui-chat\README.md:67`).
* Composer-статистика: `activity` (turны/шаги, скорость, LLM time, tool time, TTFT) и `usage`
  (сумма токенов и cache hit %) (`README.md:71`). Режим задаётся `ui-chat.performanceUsage: detailed|compact`
  (в профиле сейчас `detailed`).
* Кэш учитывается из `usage.cacheReadTokens`; `totalTokens` берётся как есть. Формула pi-адаптера
  (`input = prompt − cacheRead − cacheWrite`) — хороший ориентир, если Antigravity отдаёт `cachedContentTokenCount`.

---

## 3. Вложения: что доходит до адаптера

### 3.1 Картинки

* Пользователь прикрепляет PNG/JPEG/WebP/GIF; файл нормализуется в 8-bit sRGB/sRGBA raster и сохраняется
  до отправки; при отказе падает всё сообщение (`$PKG\dsh-attachment\README.md:32`).
* Лимиты по умолчанию (`$PKG\dsh-attachment-local\lib\index.js:895-916`):
  `maxImageBytes = 20 MiB`, `maxImagesPerMessage = 20`, `maxMessageImageBytes = 200 MiB`,
  `maxImagePixels = 64e6`, `maxImageDimension = 8192`; нормализованное хранилище:
  пиксельный бюджет `2048×2048`, long edge `8192`, целевые байты `4 MiB`.
* Для route-специфичных лимитов у `llm-pi-ai` были `requestImagePixelBudget`/`requestImageMaxBytes`/
  `maxRequestImageBytes`; **нативный адаптер задаёт их сам** (при желании — через `Config` или константы).
* Адаптер получает блок `{type:'image', attachment, offloaded?}` и **сам** читает байты:

```js
const attachments = ctx.get('attachments')   // сервис вложений
const prepared = await attachments.readImageRequest(ref, { width, height, maxBytes }, options.signal)
// prepared: нормализованный request-вариант (байты + mimeType) — кладите в inlineData
```

Эталон: `dsh-llm-pi-ai/lib/index.js:1252-1260` (`prepareRequestImages` → `readImageRequest`),
`1247-1251` (пропуск `offloaded === true`). Желательно сопровождать каждую картинку текстовым дескриптором
(`requestImageHandleText` из `@deepseek-ai/dsh-llm`) — иначе модель теряет связь «где какая картинка»;
pi-ai делает это через `resolveImageAttachmentAccess` (`:2909`). Рантайм сам таких дескрипторов нативному
адаптеру не добавляет (он только заменяет картинки текстом для text-only моделей).

*Если модель объявила `inputModalities` без `image`*, DSH сам заменит картинки текстом
(`projectImagesForTextModel`, `$PKG\dsh-llm\lib\index.js:2337`) — и **отклонит загрузку** при выборе такой
модели: `session/attachment-invalid` «Model … cannot accept image attachments»
(`$PKG\dsh-api-session-controller\lib\index.js:928-945`).

### 3.2 Файлы (PDF, audio, всё остальное)

* Любой не-картиночный файл сохраняется verbatim без ограничений типа/размера, а **модель получает строку
  с путём**, а не байты (`dsh-attachment\README.md:40`).
* Проекция выполняется рантаймом **до** адаптера (`$PKG\dsh-llm\lib\index.js:2336`), формат текста —
  `fileHandleText` (`:614-621`):
  ```
  [File "<name>" (<bytes> bytes, sha256:<8hex>): verbatim read-only copy saved at "<host path>". Read that path …]
  ```
* Значит для PDF/audio нативного инлайна **нет**: адаптер увидит только текст-хэндл. Если очень нужно —
  можно распознать путь регэкспом `/saved at "([^"]+)"/` и прочитать файл самому (fs доступен процессу Host),
  затем положить `inlineData` с `application/pdf` / `audio/wav`. Это нештатная эвристика: путь может
  отсутствовать («current execution environment cannot access a readable path»), а формат текста —
  внутренняя деталь.
* В UI для файлов есть карточки и открытие в Sidebar; аудио/видео — без специальной обработки.

---

## 4. Как модели и reasoning-уровни попадают в пикер

1. `llm.listProviders()` → маршруты зарегистрированных адаптеров (`$PKG\dsh-llm\lib\index.js:1908-1910`).
2. `buildModelCatalog` (`$PKG\dsh-api-session-controller\lib\index.js:563-611`): для каждого провайдера
   `listModels(id)`, затем для **каждой** модели `resolveModelInfo(id, modelId)`; группа с пустым списком
   отбрасывается (`:604`), ошибка провайдера изолируется в `failures[]` (`:593-602`).
3. В группу попадают `{id, name, description?, reasoning?}` (`:578-583`) — т.е. **имена и уровни effort
   берутся из `resolveModel`**. `reasoning.efforts` → строки Effort в селекторе, `defaultEffort` → предвыбор
   (`$PKG\dsh-client-ui-model-selection\README.md:44`: «The popup applies the selected model's default effort»).
4. Выбор пользователя сохраняется как `{provider, model, reasoningEffort}` (`agentModelSelection`,
   `$PKG\dsh-api-session-controller\lib\index.js:547-553`); на следующем запросе приходит
   `GenerateOptions.reasoningEffort`.
5. Валидация: рантайм проверяет `reasoningEffort` против `efforts` **до** провайдерского I/O; при отсутствии
   подставляет `defaultEffort` (`$PKG\dsh-llm\lib\index.js:2178-2200`). Неизвестный уровень →
   `LlmError(… "does not support reasoning effort")`.

Практические правила для адаптера:
* `efforts` — произвольные стабильные id (`'low'|'high'|'minimal'|'off'` или свои `'thinking-1024'`):
  это **opaque-строки адаптера**, общей таксономии нет (`README.md:194`).
* Несколько «моделей-вариантов» (например `claude-sonnet-5-5-high` и `-low`, как сейчас в v0.1) можно
  оставить id-ами, но правильнее — одна модель + `reasoning.efforts`, тогда в UI появится строка Effort.
* `defaultEffort` обязателен, если хотите предсказуемый старт.

---

## 5. ГЛАВНОЕ: как отдать каждую Google-фичу через нативный адаптер

Общий принцип: **всё, что не выражается через `StreamChunk`/`content block`, отдаётся текстом** (markdown
рендерится полностью), а служебные данные (подписи, цитаты, метаданные) — через `replayState` или
`<signature>`-обёртку reasoning. У DSH нет ни citation-UI, ни structured-output-поверхности.

### 5.1 Grounding / Google Search citations

| | |
|---|---|
| Что делает адаптер | добавляет в запрос Antigravity `tools:[{googleSearch:{}}]` (и/или `urlContext:{}`), при `googleSearch` вместе с functionDeclarations — проверить, что upstream не отвергает комбинацию |
| Куда девать `groundingMetadata` | в **текстовый блок** в конце ответа: markdown-список ссылок `- [title](uri)`; заголовки/фрагменты — курсивом. Это единственный путь, который UI отрисует |
| Что не покажется | отдельного «источники»-виджета нет; аннотаций к фрагментам нет |
| Как сохранить для истории | в `replayState` (`{grounding:[...]}`) — переживёт ходы, но пользователю не видно |
| Альтернатива | зарегистрировать свой tool (`ctx.tools.register`) `google_search` и вернуть результаты как tool-result — тогда цитаты попадут в лог как структура, но это меняет поведение агента |

Сниппет (внутри формирования запроса):

```js
const body = { model, contents, systemInstruction, generationConfig }
if (config.grounding === true) body.tools = [{ googleSearch: {} }]   // + ваши functionDeclarations отдельным элементом
...
// при парсинге ответа: groundingMetadata.groundingChunks[].web.{uri,title}
const sources = chunks.map((c) => `- [${c.web?.title ?? c.web?.uri}](${c.web?.uri})`).join('\n')
yield { type: 'text-delta', index, text: `\n\n### Sources\n${sources}\n` }
```

### 5.2 Code execution (server-side Python)

| | |
|---|---|
| Запрос | `tools:[{codeExecution:{}}]` |
| Ответ upstream | parts: `executableCode {language, code}` и `codeExecutionResult {outcome, output}` |
| Как отдать | **текстом**: fenced code-блок ``` ```python … ``` ``` + блок «Output», оба рендерятся MarkdownText |
| Не мапить в `tool-call` | loop попытается выполнить инструмент, которого нет в реестре → ошибка хода |
| Метаданные | в `replayState`, чтобы на следующем ходу не дублировать код |

### 5.3 Image generation (gemini image-модель)

| | |
|---|---|
| Запрос | `generationConfig.responseModalities:['TEXT','IMAGE']`; ответ — part `inlineData {mimeType, data}` |
| Как показать | сохранить байты в файл и эмитить **markdown** `![](C:/abs/path.png)` (§2.5); либо `image`-блок (экспериментально, §2.3B) |
| Где путь | любой абсолютный, читаемый Host'ом; `api/file` отдаёт файлы и вне воркспейса (`api-workspace-files:421`) |
| Имя/расширение | `image/png|jpeg|webp` — у `image-generation` моделей обычно PNG; писать `.png` |
| Что не покажется | «inline image part» ассистента в исходном виде; галереи/скачивания для ассистента нет |

```js
// обработка ответа: part.inlineData
const ext = part.inlineData.mimeType === 'image/jpeg' ? 'jpg' : 'png'
const file = `C:/lab/antigravity/generated/${Date.now()}.${ext}`
await fs.promises.mkdir(path.dirname(file), { recursive: true })
await fs.promises.writeFile(file, Buffer.from(part.inlineData.data, 'base64'))
yield { type: 'text-delta', index, text: `![${ext}](${file})` }
```

### 5.4 Structured output (`responseMimeType` + `responseSchema`)

* **В DSH этой поверхности нет.** `GenerateOptions` не содержит `response_format`/`json_schema`/`responseSchema`;
  pi-ai-маршрут тоже никогда не отправляет `response_format` (в `openai-completions.js` его нет вообще — grep по
  64 КБ файла). Значит, «попросить JSON по схеме» из агента нельзя.
* Где это может пригодиться: собственные вспомогательные вызовы адаптера (например, заголовок сессии,
  классификация). Тогда адаптер сам добавляет `generationConfig.responseMimeType='application/json'` и
  `responseSchema` (схема в формате Gemini) для конкретных model id/режимов, а результат отдаёт обычным
  текстом — DSH его просто покажет/запишет.
* Если нужно «структурное» поведение в агенте — делайте это **инструментом** (function calling), а не
  response_format: у DSH весь структурированный обмен идёт через `tool-call`.
* Для OpenAI-совместимой совместимости: compat-флагов structured output в DSH нет; `supportsStrictMode` —
  это про `strict` в tool-схемах pi-ai, к нативному адаптеру отношения не имеет.

### 5.5 Thinking budgets / thinking level

| | |
|---|---|
| Объявление | `resolveModel().reasoning.efforts` (id + name) + `defaultEffort` |
| Выбор | пользователь в селекторе модели → строка Effort → `options.reasoningEffort` в `stream()` |
| Маппинг | `low|medium|high` → `generationConfig.thinkingConfig.thinkingLevel`; числовой бюджет → `thinkingBudget` (512/-1/0 — по фактам research Antigravity); `includeThoughts:true` чтобы пришёл `thought`-part |
| Отображение | `thought`-part → `reasoning-delta` → блок «Thinking» (markdown, свёрнут) |
| Подпись | `thoughtSignature` — в `replayState` (не в тексте!), чтобы не показывать пользователю |
| Важно | если reasoning не объявлен вовсе (`reasoning` отсутствует) — строка Effort не появится; `reasoningEfforts:false` в конфиге pi-ai аналога здесь нет, просто не задавайте `reasoning` |

### 5.6 Audio / PDF вход

* Через DSH — **никак**: файлы проецируются в текст-хэндл с путём, байты до адаптера не доходят (§3.2);
  audio/video «no dedicated handling yet» (`dsh-attachment\README.md:118`).
* Максимум: распознать путь в тексте-хэндле и прочитать файл самому, затем отправить `inlineData` с
  `application/pdf` / `audio/wav` / `audio/mp3`. Это единственный способ дать Antigravity настоящий PDF/audio,
  и он хрупок (зависит от формата текста и наличия пути). Плюс лимиты inlineData upstream (см. research task-1).
* Изображения — единственная модальность, которая доходит штатно (через `ImageAttachmentRef`).

---

## 6. Конфиг плагина и патч профиля (нативный вариант)

Плагин может не иметь `Config` вовсе (тогда `apply(ctx, undefined)`), либо объявить свою схему
(Standard Schema v1 — как gigachat: обычный объект с `'~standard'.validate`). Пример конфига:

```yaml
- insert:
    - id: antigravity-llm
      name: "C:/lab/antigravity/plugin/index.mjs"
      config:
        models:                     # если хотите управлять каталогом из патча
          - id: gemini-3-flash
            name: Gemini 3 Flash
            contextWindow: 1048576
            maxTokens: 65536
            input: [ text, image ]
        defaultThinkingBudget: 1024
        project: null               # опционально: id проекта Antigravity
        debugDir: "C:\\lab\\antigravity\\logs"
```

Обязательные изменения в `$PROFILE\cordis.patch.yml` при переходе на нативный адаптер:

0. Поля `config` работают только если плагин объявил `Config`-схему; в скелете §1.10 каталог берётся из
   константы `MODELS`, и `config` игнорируется (передаётся в `apply` вторым аргументом).
1. Удалить из строки `- id: llm-pi-ai` блок `providers.antigravity` (и комментарии-managed-block v0.1):
   иначе второй адаптер на маршрут `antigravity` → `DUPLICATE_ADAPTER`.
2. Заменить insert-строку `antigravity-gateway` (HTTP-шлюз) на `antigravity-llm` (нативный адаптер).
3. `agent-default-model` можно оставить как есть (`deepseek-official`), модель выбирается в пикере;
   если нужен дефолт — `provider: antigravity, model: gemini-3-flash`.

Проверка: `cordis_inspect_query` (`Config.listConfigs`) показывает строку `antigravity-llm`;
пикер — группу `Antigravity` с моделями; Host-лог — `antigravity: native LLM adapter registered`.

---

## 7. Как проверить (read-only, без гадания)

1. **Импорт и форма объекта**: `node --input-type=module -e "const m=await import('file:///C:/lab/antigravity/plugin/index.mjs');console.log(Object.keys(m))"` →
   ждём `apply,inject,name` (+`Config`); затем глазами: у адаптера есть `providerInfo`, `providerRetryPolicy`,
   `listModels`, `resolveModel`, `prepareCall` (иначе см. §1.1 — регистрация/запрос упадут).
2. **Регистрация в живом профиле**: после монтирования
   `cordis_inspect_query {platform:'host', provider:'Config', method:'listConfigs'}` → запись
   `include:antigravity-llm` (статус `schema` или `absent`, но не `inactive`).
3. **Каталог моделей**: пикер модели в Web UI — группа `Antigravity` + строки моделей + строка Effort
   (есть только при `reasoning.efforts`).
4. **Стрим**: отправить сообщение; в ответе по очереди появляются text/reasoning; в композере — usage
   (без `usage`-чанка строка статистики скроется).
5. **Отмена**: нажать «stop» → адаптер получает `signal.aborted`, финал — `finish{kind:'aborted'}`;
   в UI — «stopped».
6. **Картинка**: `![x](C:/abs/path.png)` в ответе должен отрисоваться превью + лайтбокс.
7. **Ошибки**: неверный api-ключ/401 → `finish{kind:'error', failure.code:'AUTH'}` и красная строка хода;
   `curl`/лог адаптера покажет исходный HTTP-код.

---

## 8. Риски и подводные камни

1. **Absolute-path mount и импорты.** Плагин абсолютным путём не может импортировать `@deepseek-ai/dsh-llm`
   (его файлы вне профиля) → либо zero-import (скелет §1.10), либо `link:`-зависимость (§1.11).
2. **`DUPLICATE_ADAPTER`.** Пока в `llm-pi-ai.providers` живёт `antigravity`, нативный адаптер на тот же
   маршрут не зарегистрируется; ошибка попадёт в warning плагина и адаптер не появится в пикере.
3. **`resolveModel` — критичная точка.** Любое нарушение валидации (`id !== model`, пустой `name`,
   `contextWindow <= 0`, пустой `efforts`, `defaultEffort` вне списка) делает провайдера невидимым/неиспользуемым
   (`INVALID_MODEL_*`). Ошибку видно только в Host stderr / crash-логе.
4. **`usage` обязателен** для статистики; «приблизительные» значения тоже скрывают disclosure
   (`ui-chat README:67`). `totalTokens` не пересчитывается — передавайте как есть.
5. **`arguments` tool-call — строка JSON**, не объект; иначе loop получит невалидные аргументы
   (ассемблер просто конкатенирует `argumentsDelta`).
6. **`max-tokens` отбрасывает tool-call блоки** (`llm/index.js:1053`) — не удивляйтесь, если неполный вызов
   исчез.
7. **`toolUpdate` не задан** → developer-сообщения с `tool-addition`/`tool-removal` вырезаются, а `tools`
   приходит полным текущим списком. Если ваша модель Gemini требует полный список в начале — это как раз
   ваш режим.
8. **Картинки**: без `inputModalities:['text','image']` DSH заменит их текстом, а отправка вложения
   будет отклонена на уровне сессии (`session/attachment-invalid`).
9. **`maxRequestImageBytes` и подписи**: нативный адаптер сам решает, сколько байт картинок отправлять;
   Antigravity inlineData имеет собственный лимит (см. research), отсутствие своего бюджета даёт 400/413.
10. **Секреты**: не кладите токены в `Config` патча без нужды — они попадут в файл профиля. Храните в
    `$DSH_HOME\.credentials.yaml`/`.env` и читайте через `ctx.credentials`/`process.env` (сервис
    `credentials` — `credentials.resolve(ref)`).
11. **HMR**: правки файла плагина по абсолютному пути HMR **не** видит (§1.11) — после правок либо
    disable/enable строки, либо рестарт; для `link:`-варианта подхватываются сами.
12. **Публичных citations-API нет**: всё, что не текст, пользователь не увидит; храните метаданные в
    `replayState`, а видимое — в тексте.

---

## 9. Приложение: индекс доказательств

| Утверждение | Источник (файл:строка) |
|---|---|
| `LlmAdapter` (методы, дефолты) | `$PKG\dsh-llm\lib\index.js:1670-1755` |
| `registerAdapter` + валидация `providerInfo` + `DUPLICATE_ADAPTER` | `$PKG\dsh-llm\lib\index.js:1842-1887` |
| `providerRetryPolicy` вызывается безусловно при регистрации | `$PKG\dsh-llm\lib\index.js:1876` |
| `adapter.prepareCall` вызывается безусловно | `$PKG\dsh-llm\lib\index.js:2224`, `:2318`; дефолт класса — `:1749-1753` |
| `imageRequestTarget` вызывается рантаймом; `imageRequestPricing` опционален | `$PKG\dsh-llm\lib\index.js:2053-2065` |
| `listProviders` | `$PKG\dsh-llm\lib\index.js:1908-1910` |
| `listModels` валидация (`INVALID_CATALOG`) | `$PKG\dsh-llm\lib\index.js:2086-2101` |
| `resolveModel` → `normalizeModelInfo` (все поля, все ошибки) | `$PKG\dsh-llm\lib\index.js:2119-2163` |
| `BlockAssembler.push` / `assemble` / дефолт finish | `$PKG\dsh-llm\lib\index.js:964-1005`, `:1020-1038`, `:1102`, `:1109` |
| проекции перед dispatch (files→text, images→text, tools) | `$PKG\dsh-llm\lib\index.js:2335-2349` |
| конвертация ошибки адаптера в finish | `$PKG\dsh-llm\lib\index.js:2401-2414`, `:402-460`, `:463-477` |
| attribution-заголовки (`user-agent`) | `$PKG\dsh-llm\lib\index.js:849-879`, `:1664-1668` |
| обязательность attribution для адаптера | `$PKG\dsh-llm\lib\index.js:1664-1668` |
| `fileHandleText` (формат текста файла) | `$PKG\dsh-llm\lib\index.js:614-621` |
| GenerateOptions-поля | `$PKG\dsh-llm-deepseek\lib\index.js:2145-2243`; `$PKG\dsh-llm-pi-ai\lib\index.js:1983-2010` |
| эталонный `translate()` → чанки | `$PKG\dsh-llm-deepseek\lib\index.js:1939-2031` |
| эталонные `listModels`/`resolveModel`/`stream` | `$PKG\dsh-llm-pi-ai\lib\index.js:1887-1940`, `:1537-1653` |
| `mapUsage` (usage shape) | `$PKG\dsh-llm-pi-ai\lib\index.js:1439-1447` |
| replayState-конверт (эталон) | `$PKG\dsh-llm-pi-ai\lib\index.js:61-142`, `:244-246` |
| ассистентский image-блок невозможен в pi-ai | `$PKG\dsh-llm-pi-ai\lib\index.js:169` |
| пикер: `buildModelCatalog` (listProviders→listModels→resolveModelInfo) | `$PKG\dsh-api-session-controller\lib\index.js:563-611` |
| выбор модели → `reasoningEffort` в селекцию | `$PKG\dsh-api-session-controller\lib\index.js:547-553` |
| image-modality gate (`session/attachment-invalid`) | `$PKG\dsh-api-session-controller\lib\index.js:928-945` |
| рендер блоков ассистента (text/reasoning/image/tool-call) | `$PKG\dsh-client-ui-chat\lib\client.js:6290-6364` |
| markdown-картинки и `api/file` | `$PKG\dsh-client-ui-chat\lib\client.js:45-95`, `:6280-6294` |
| `api/file` отдаёт файлы вне воркспейса | `$PKG\dsh-api-workspace-files\lib\index.js:421` |
| reasoning: свёртка, `**`, `<signature>` | `$PKG\dsh-client-ui-chat\lib\client.js:6113-6127`, `:6187-6230` |
| usage-строка/композер-статистика | `$PKG\dsh-client-ui-chat\README.md:65-71` |
| markdown-изображения/ссылки/сайдбар | `$PKG\dsh-client-ui-chat\README.md:37-48` |
| вложения: картинки/файлы/лимиты | `$PKG\dsh-attachment\README.md:32,40,52,118,134-136` |
| лимиты изображений (числа) | `$PKG\dsh-attachment-local\lib\index.js:895-916` |
| чтение картинки адаптером (`readImageRequest`) | `$PKG\dsh-llm-pi-ai\lib\index.js:1247-1260` |
| `response_format` отсутствует в pi-ai | `$ASAR\dsh\node_modules\@earendil-works\pi-ai\dist\api\openai-completions.js` (grep: 0 совпадений) |
| GenerateOptions без tool_choice/top_p/penalties | `$PKG\dsh-llm\README.md:177` |
| адаптер не ретраит, коды ошибок | `$PKG\dsh-llm\README.md:93-97` |
| reasoning efforts — opaque-строки адаптера | `$PKG\dsh-llm\README.md:194` |
