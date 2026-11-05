# DSH-сторона: как зарегистрировать нового LLM-провайдера и модели в профиле `desktop`

Разведка выполнена 2026-11-05 на живом профиле (приложение запущено, ничего не менялось).
Всё ниже проверено по установленному коду и живому состоянию; ссылки вида `путь:строка` — доказательства.
Артефакты разведки: `C:\lab\antigravity\research\dsh\` (см. §11).

Соглашения:

| Символ | Значение |
|---|---|
| `$ASAR` | `C:\Users\zxclu\AppData\Local\Programs\DeepSeek Harness\resources\app.asar` |
| `$PKG` | `$ASAR\dsh\node_modules\@deepseek-ai` |
| `$PROFILE` | `C:\Users\zxclu\.dsh\profiles\desktop` |
| `$DSH_HOME` | `C:\Users\zxclu\.dsh` |
| `$CLI` | `C:\Users\zxclu\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd` |

---

## 0. Ответ на одной странице

1. DSH **0.2.1-rc.5**, профиль `desktop`. Пакет провайдера — **`@deepseek-ai/dsh-llm-pi-ai` 0.2.1-rc.5**, живёт **внутри установки**:
   `$PKG\dsh-llm-pi-ai` (не в профиле). На нём уже висят 4 маршрута (`lithos-ai`, `lol`, `gnida`, `gigachat`).
2. Провайдер объявляется **только конфигом** этой строки: `providers.<route>.{displayName, api, baseURL, apiKeyEnv, headers, timeoutMs, streamIdleTimeoutMs, models[]}`.
   `api` для локального OpenAI-совместимого шлюза — **`openai-completions`** (всего допустимо три значения, §2.3).
   Свои `headers` — да, на уровне маршрута, словарь строк.
3. Плагин нужен **только как HTTP-шлюз** (как `dsh-plugin-gigachat`): Cordis-плагин, поднимающий `127.0.0.1:<port>/v1`,
   ставится в профиль как `link:`-зависимость, монтируется строкой `insert` в `$PROFILE\cordis.patch.yml`.
   Второй архитектурный вариант — регистрировать свой `LlmAdapter` напрямую через `ctx.llm.registerAdapter` (§5.6), он дороже и рискованнее.
4. Пикер моделей в Web UI берёт список **из реестра LLM-адаптеров**, а не из пресетов и не из отдельного списка:
   `llm.listProviders()` + `adapter.listModels(provider)` → клиентский `session.models`. Отдельный список id моделей нигде дублировать не нужно.
5. Модели появятся в селекторе автоматически после того, как строка `llm-pi-ai` получит маршрут с непустым `models[]`
   **и разрешимой ссылкой на ключ** (`apiKeyEnv`) — при `MISSING_CREDENTIAL` `listModels()` возвращает `[]` и группа в пикере пустая.
6. Правка `cordis.patch.yml` применяется **живьём** (HMR + volatile-конфиг). Рестарт нужен только на этап установки
   зависимости (`pnpm add link:...`), т.е. полный перезапуск приложения — самый простой и надёжный путь.
7. `dsh --profile desktop --dump-config` **запрещён** (`profile "desktop" is managed exclusively by the Electron application`).
   Проверка — через `cordis_inspect_query` (живой), Web UI или копию профиля под другим именем (§6).

---

## 1. Точная версия установленного DSH

| Факт | Значение | Доказательство |
|---|---|---|
| Runtime-пакет | `@deepseek-ai/dsh-desktop-runtime` **0.2.1-rc.5** | `$ASAR\dsh\package.json:2-4` |
| Версия CLI | `0.2.1-rc.5` | `& $CLI --version` → `0.2.1-rc.5` |
| Node / pnpm рантайма | **24.21.0 / 11.28.5** | `$DSH_HOME\dsh-runtimes\dsh-primary-runtime\runtime.json` |
| pnpm, которым записан профиль | `pnpm@11.28.5`, `nodeLinker: hoisted` | `$PROFILE\node_modules\.modules.yaml` |
| Cordis | 4.0.5 | `$ASAR\dsh\package.json:7` |
| pi-ai | `@earendil-works/pi-ai` **1.1.0** | `$PKG\dsh-llm-pi-ai\package.json:46` (`^1.1.0`) + `$ASAR\dsh\node_modules\@earendil-works\pi-ai\package.json:3` |
| Electron | 44 (Desktop 0.2.1-rc.5) | `runtime.json -> desktopVersion` |

Важно: `.d.ts`-файлы в установку **не попали** (`$PKG\dsh-llm-pi-ai\package.json:25-29` их объявляет, но в asar их нет —
проверено чтением архива, `research\dsh\asar-cat.js`). Авторитетная схема = `lib/index.js` + живая проекция JSON Schema (§2.2).

---

## 2. Пакет провайдера: где лежит и какая у него схема

### 2.1 Расположение и идентичность

| | |
|---|---|
| Имя | `@deepseek-ai/dsh-llm-pi-ai` |
| Версия | `0.2.1-rc.5` (`package.json:4`) |
| packageDir | `C:\Users\zxclu\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-llm-pi-ai` |
| Откуда packageDir известен | живой `cordis_inspect_query {platform: host, provider: Config, method: listConfigs, input: {entry: "include:llm-pi-ai"}}` → поле `packageDir` |
| Экспорт плагина | `name = "llm-pi-ai"`, `inject = ["llm"]` (`lib\index.js:2815-2816`), `apply` (`:2860`) |
| Точка входа | `main: lib/index.js`, `"type": "module"` (`package.json:13-15`) |
| В профиле | **не** лежит: профиль берёт его из установки (`$PROFILE\node_modules` содержит только `dsh-plugin-gigachat`, `dsh-plugin-telegram`) |
| Строка в базовом бандле | `$PKG\dsh-base\cordis.patch.yml:135-136` (`- id: llm-pi-ai`, `name: '@deepseek-ai/dsh-llm-pi-ai'`, без `config` → «дремлющий» режим) |

### 2.2 Схема `Config` (по коду + живой проекции)

Корень: `Config = z.object({ providers: z.dict(profile).default({}).volatile() })` — `lib\index.js:1083`.
`providers` — **словарь**, ключ = id маршрута (`GenerateOptions.provider`); массив больше не принимается
(`resolveProfiles` → `"llm-pi-ai: providers is now a dict keyed by provider route, not an array of profiles"`, `:1118`).
`.volatile()` — поле, которое Loader коммитит без перемонтирования (`loader/volatile-update`), и именно на нём
плагин пере-регистрирует маршруты (`lib\index.js:2957-2965`). Живая проекция схемы сохранена:
`research\dsh\live-config-schema-llm-pi-ai.json`.

`profile` = `lib\index.js:1049-1081`; поля:

| Поле | Тип / значение | Смысл |
|---|---|---|
| `apiKeyEnv` | string, `role: "credential-ref"` | имя ссылки на креденшел, резолвится **на каждый запрос** через credential-seam (сначала `credentials.resolve`, затем env/`.env`). Не задано → «сконфигурирован, но без ключа» (полагается на ambient-аутентификацию pi-ai). Не разрешилось → `MISSING_CREDENTIAL` (`:2892-2899`) |
| `displayName` | string | имя группы провайдера в пикере; по умолчанию = ключ маршрута (`:1137`, `:1878-1883`) |
| `api` | `"openai-completions" \| "openai-responses" \| "anthropic-messages"` | рroducewire-протокол; **обязателен** для маршрута, которого нет в каталоге pi-ai (`:689-690`) |
| `baseURL` | string | корень API всех моделей маршрута; **обязателен** для не-каталожного маршрута (`:691-692`) |
| `models` | массив `modelProfile` (`id`, `name`, `contextWindow`, `maxTokens`, `input`, `reasoningEfforts`, `compat`) | **заменяет** каталог маршрута целиком; для не-каталожного маршрута должен быть непустым (`:660`, `:678`) |
| `modelOverrides` | словарь по id | правит отдельные модели *установленного* каталога; запрещён вместе с `models` и на не-каталожном маршруте (`:663-673`) |
| `compat` | `compatProfile` (см. ниже) | переключатели совместимости на весь маршрут |
| `defaultContextWindow` | int ≥ 1, **default 262144** | подставляется модели без своего `contextWindow` (`:1057`, `:693`) |
| `defaultMaxTokens` | int ≥ 1, **default 32768** | то же для выхода (`:1058`, `:695`) |
| `defaultInput` | массив модальностей, default `["text"]` | модальности по умолчанию (`:1059`, `:705`) |
| `headers` | `z.dict(z.string())` | **свои HTTP-заголовки**, добавляются к каждому запросу маршрута (`:1060`, `:1816-1824`) |
| `reasoning` | `off\|minimal\|low\|medium\|high\|xhigh\|max` | уровень рассуждений по умолчанию для маршрута |
| `thinkingBudgets` | `{minimal,low,medium,high}` числа | бюджеты токенов для уровней |
| `cacheRetention` | `none\|short\|long` | политика кэша промпта |
| `transport` | `sse\|websocket\|websocket-cached\|auto` | транспорт pi-ai |
| `timeoutMs` | целое ≥ 0 (`z.natural`) | таймаут операции; уходит в pi-ai как `timeoutMs` при `maxRetries: 0` (`:1762-1764`) |
| `websocketConnectTimeoutMs` | целое ≥ 0 | только для ws-транспорта |
| `streamIdleTimeoutMs` | число, **default 300000**, ≤ 2147483647 | «сторож» простоя SSE-стрима; при срабатывании `LlmError("pi-ai stream idle timeout after Nms", "TIMEOUT")` (`:1076`, `:1957-2009`) |
| `maxRequestImageBytes` | int ≥ 1, default 20971520 | лимит base64-картинок в запросе |
| `requestImagePixelBudget` | int ≥ 1, default 4194304 | пиксельный бюджет одной картинки |
| `requestImageMaxBytes` | int ≥ 1, default 1048576 | целевой размер картинки до base64 |
| `retryPolicy` | `{mode:"normal"\|"always", maxRetries?, retryableCodes?, backoff?}` | политика ретраев на маршрут (исполняет `dsh-llm-retry`) |

`models[]` (`modelFields` + `id`): `lib\index.js:1035-1046`

| Поле | Тип | Смысл |
|---|---|---|
| `id` | string, **обязателен**, уникален в списке (`:685-687`) | уходит на провод как `model` |
| `name` | string | отображаемое имя в пикере; по умолчанию = `id` (`:701`) |
| `contextWindow` | int ≥ 1 | окно контекста; если не задать — молча возьмётся `262144` |
| `maxTokens` | int ≥ 1 | максимум выхода; если не задать — `32768` |
| `input` | `["text","image"]` | модальности; **пусто/нет = text-only**, картинки будут отклонены до отправки |
| `reasoningEfforts` | `false` \| `{off: ..., low: ..., high: ...}` | какие уровни предлагать; ключ = уровень, значение = написание на проводе (`off:` без значения допустим). `false` = нерассуждающая модель (`:1033`, `:1040`) |
| `compat` | объект | switch-и на одну модель |

`compatProfile` (общий и для маршрута, и для модели) — `lib\index.js:995-1022`, ключи:
`supportsStore`, `supportsDeveloperRole`, `supportsReasoningEffort`, `supportsUsageInStreaming`,
`supportsFinishReason`, `maxTokensField` (`max_completion_tokens|max_tokens`), `requiresToolResultName`,
`requiresAssistantAfterToolResult`, `requiresThinkingAsText`, `requiresReasoningContentOnAssistantMessages`,
`thinkingFormat` (`openai|deepseek|openrouter|together|baseten|zai|qwen|chat-template|qwen-chat-template|string-thinking|ant-ling`),
`chatTemplateKwargs`, `chatTemplateArgs`, `supportsThinkingTokenBudget`, `thinkingTokenBudgetField`
(`thinking_token_budget|thinking_budget|thinking_budget_tokens`), `vllmPriority`, `supportsMaxOutputTokens`,
`supportsStrictMode`, `cacheControlFormat` (`anthropic`), `supportsLongCacheRetention`,
`supportsEagerToolInputStreaming`, `supportsCacheControlOnTools`, `supportsTemperature`,
`forceAdaptiveThinking`, `allowEmptySignature`, `supportsStrictTools`.

### 2.3 Допустимые `api` и что брать для локального шлюза

```js
// $PKG\dsh-llm-pi-ai\lib\index.js:834-838
const PROTOCOLS = {
  "openai-completions": openAICompletionsApi,
  "openai-responses": openAIResponsesApi,
  "anthropic-messages": anthropicMessagesApi
};
```

`supportedProtocols()` = ровно эти три, в этом порядке (`:847-849`). Bedrock/Vertex/Azure/Codex намеренно не предлагаются
для ручных маршрутов (`:816-833`); каталожные маршруты до них всё равно достают.

*Для локального OpenAI-совместимого шлюза — **`openai-completions`*** — именно так в этом профиле работают `gigachat`
(шлюз на `127.0.0.1:8731/v1`) и `lithos-ai` (`https://api.lithosai.cloud/v1`). `baseURL` — корень OpenAI API:
путь `/chat/completions` добавляет OpenAI-SDK внутри pi-ai (pi-ai 1.1.0 зависит от `openai@7.19.0`,
`pi-ai\package.json:66`), поэтому в живом профиле `baseURL` всегда оканчивается на `/v1`.

### 2.4 `headers`: да, поддерживаются (только на маршруте)

* `headers: z.dict(z.string())` — `lib\index.js:1060`;
* проверка на валидность HTTP-поля: `new Headers([[name, value]])`, иначе ошибка
  `provider "<route>" header "<name>" is not valid for Fetch` (`:1102-1108`);
* применяются к запросу: `requestHeaders(profile.headers)` — свои заголовки идут первыми, затем **поверх** них
  attribution-заголовки (совпадения по имени в нижнем регистре вытесняются) (`:1816-1824`, вызов `:1989`);
* в Models-странице Web UI `headers` **не редактируются** — «Profile `headers` remain deployment configuration in `cordis.patch.yml`»
  (`$PKG\dsh-client-ui-settings-models\README.md:56`);
* `headers` — только на маршрут, не на модель.

Это же и есть штатный способ отдать локальному шлюзу фиктивный `Authorization` (см. §7.1).

---

## 3. Живой профиль: как он устроен сейчас

### 3.1 `$PROFILE\package.json` (полный текст, 21 строка)

```json
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dependencies": {
    "dsh-plugin-gigachat": "link:C:/lab/gigachat",
    "dsh-plugin-telegram": "github:citedy/dsh-telegram-bot"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@deepseek-ai/dsh-experimental-agent-team-profile",
        "@deepseek-ai/dsh-experimental-tool-worktree",
        "@deepseek-ai/dsh-experimental-session-search",
        "@deepseek-ai/dsh-experimental-session-titles-bundle",
        "@deepseek-ai/dsh-experimental-plugin-market-bundle"
      ]
    }
  }
}
```

`dsh-plugin-gigachat` — `link:`-зависимость (junction); `dsh-plugin-telegram` в `node_modules` есть, но в `bundles`/патче не участвует,
т.е. инертен. `node_modules` профиля: `.bin`, `.pnpm`, `dsh-plugin-gigachat` (ReparsePoint), `dsh-plugin-telegram`, `.modules.yaml`, `.pnpm-workspace-state-v1.json`.

### 3.2 `$PROFILE\cordis.patch.yml` — как выглядит строка `llm-pi-ai`

Файл: 243 строки, top-level YAML-массив. Порядок слоёв: бандлы → этот файл → `--patch`.
Единственный home-слой `$DSH_HOME\cordis.patch.yml` **отсутствует** (проверено листингом `$DSH_HOME`), поэтому precedence
«home > profile» здесь не мешает.

Строки **88-196** — интересующая нас строка (id `llm-pi-ai`, override базовой строки по id):

```yaml
- id: llm-pi-ai                       # 88
  name: "@deepseek-ai/dsh-llm-pi-ai"  # 89
  config:                             # 90
    providers:                        # 91
      lithos-ai: {apiKeyEnv: LITHOS_AI_API_KEY, api: openai-completions, baseURL: https://api.lithosai.cloud/v1,
                  models: [ …16 моделей… ]}          # 92-139
      lol:       {api: openai-responses, baseURL: http://127.0.0.1:1234/v1, models: [qwen3.5-9b-…], apiKeyEnv: LOL_API_KEY}  # 140-149
      gnida:     {api: openai-completions, baseURL: https://deuce-sprint-footsie.ngrok-free.dev/v1, models: [colab], apiKeyEnv: GNIDA_API_KEY}  # 150-156
      gigachat:  {displayName: GigaChat, api: openai-completions, apiKeyEnv: GIGACHAT_AUTH_KEY,   # 157-196
                  baseURL: http://127.0.0.1:8731/v1, timeoutMs: 300000, streamIdleTimeoutMs: 300000,
                  models: [GigaChat-3-Ultra, -3-Pro, -3-Lightning, -2-Max, -2-Pro, -2]}
```

Строки 234-243 — `insert`-строка локального плагина-шлюза:

```yaml
- insert:
    - id: gigachat-gateway
      name: dsh-plugin-gigachat
      config: {port: 8731, host: 127.0.0.1, authKeyEnv: GIGACHAT_AUTH_KEY,
               authKeyFile: 'C:\lab\gigachat\auth.key', scope: GIGACHAT_API_PERS, upstream: https://api.giga.chat}
```

**Критично:** патч **заменяет `config` целиком** (не мержит). См. `$PKG\dsh-app-boot\README.md:48-52` и
`lib\index.js:61-110` (`for (const [key, value] of Object.entries(overrides)) target[key] = value`).
Поэтому, добавляя провайдера, надо **переписать весь блок `providers`**, включая `lithos-ai`, `lol`, `gnida`, `gigachat`.
Готовый полный блок — §8 приложения.

Прочие строки, на которые опирается модель-выбор и дефолт:
`- id: agent-default-model` (82-87) — `provider: deepseek-official, model: deepseek-flash, reasoningEffort: high`
(дефолт только для новых сессий; выбор в пикере его перекрывает);
`- id: agent-preset-registry` (226-230) — `default: standard, selectedDefault: ptc` (пресеты к списку моделей отношения не имеют, §4).

### 3.3 Как локальный пакет становится резолвимым в профиле

Работают ровно два пути (оба проверены ранее, см. `C:\lab\gigachat\docs\plugin-contract.md` §4.1, §4.3):

**A. `link:`-зависимость + pnpm (рекомендуется)** — junction в `$PROFILE\node_modules`, target вне profile-tree
→ попадает и в `localPackageNames`, и в `linkedRoots`; peer-импорты `@deepseek-ai/*` резолвятся из профиля
(`plugin-contract.md:185-209, 766-799`). Так установлен `dsh-plugin-gigachat`.

**B. `insert.name` абсолютным путём к файлу** — без установки: `name: 'C:/lab/antigravity/index.mjs'`
(конвертируется в `file:///…`, `plugin-contract.md:104-138`). Минус: HMR **не** следит за файлами вне профиля →
правки в коде плагина не подхватываются без disable/enable или рестарта (`plugin-contract.md:1016-1020`).
Указывать надо **файл**, не каталог (`ERR_UNSUPPORTED_DIR_IMPORT`).

**Не работает:** `install_bundle`/Plugins-страница/Dialog «Add plugin» — они принимают только **бандлы**,
у которых есть `dsh.bundle.patch`; иначе `ManagementFailure("not-bundle")` (`$PKG\dsh-plugin-manager\lib\index.js:2072-2077`).
Плагин без `dsh.bundle` — «файловая операция».

Точная команда установки (единый источник pnpm — bundled 11.28.5, `manageDesktopProfile: true` — этот launcher
разрешает управлять зарезервированным профилем `desktop`; проверено: `plugin … list --depth 0` печатает дерево зависимостей):

```powershell
$CLI = 'C:\Users\zxclu\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
& $CLI plugin --profile desktop add link:C:\lab\antigravity\plugin
```

Эквивалент без launcher'а (тоже проходит, `plugin-contract.md:766-778`), но со «своим» pnpm:

```powershell
$NODE = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$PNPM = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.cjs"
Set-Location "$env:USERPROFILE\.dsh\profiles\desktop"
& $NODE $PNPM add link:C:\lab\antigravity\plugin
```

Ограничение CLI: `dsh --profile desktop …` и `--dump-config` для `desktop` **запрещены**
(`$PKG\dsh\lib\bin.js:35-37`, вызов на `:112` → `error: profile "desktop" is managed exclusively by the Electron application`);
но подкоманда `plugin` проверяет флаг `manageDesktopProfile` (`:119`) и через `$CLI` (Desktop-carrier) разрешена.

---

## 4. Откуда Web UI берёт список провайдеров и моделей

Цепочка (снизу вверх), всё в установленном коде:

1. **Реестр адаптеров** `ctx.llm`: `registerAdapter(routes, adapter)` — `$PKG\dsh-llm\lib\index.js:1842-1861`;
   повторная регистрация чужого маршрута = `LlmError("an adapter for provider … is already registered", "DUPLICATE_ADAPTER")` (`:1872`).
2. `llm.listProviders()` возвращает **маршруты зарегистрированных адаптеров** (`:1908-1910`); каждый адаптер отдаёт
   `providerInfo(provider) → {id, name}`; у pi-ai `name = displayName` (`$PKG\dsh-llm-pi-ai\lib\index.js:1878-1883`).
3. Модели — `adapter.listModels(provider)`. У pi-ai это модели сконфигурированного каталога маршрута (`:1887-1904`).
   Контракт прямо говорит: «Adapters used there [GUI] must advertise their available models; the base empty catalog offers no GUI selection»
   (`$PKG\dsh-llm\lib\index.js:1713-1723`). **Отсюда вывод: список моделей в UI = `models[]` конфига.**
4. Клиент: `@deepseek-ai/dsh-client-ui-model-selection` (строка `ui-model-selection`,
   `$PKG\dsh-web-app\cordis.patch.yml:412-413`) — «Two entries over ONE per-session directory owned by `ModelDirectoryResolver`
   (`ctx.modelDirectories`) … load the session's available directory through `session.models`»
   (`$PKG\dsh-client-ui-model-selection\README.md:76`). Пустой каталог → «No models available» (`:34`).
   Директории перезапрашиваются по событиям `llm/adapters-updated`, `settings/document-updated`, credential-update (`:76`).
5. `llm/adapters-updated` публикуется при каждой мутации набора маршрутов (`$PKG\dsh-llm\lib\index.js:1819-1828, 1895-1903, 1941`).

**Следствия для задачи:**

* Отдельного «списка моделей в пресете агента» нет: пресет — это композиция плагинов/промптов
  («Indirectly, through the declared plugins, which own model-visible tools and prompts» — `$PKG\dsh-agent-preset\README.md`).
  Ничего, кроме `llm-pi-ai.providers.<route>.models[]`, перечислять не нужно.
* Провайдер, добавленный в `llm-pi-ai`, появляется в пикере **сам**, без правок UI-плагинов и без пересборки фронтенда.
* Пикер группирует по провайдеру: заголовок группы = `displayName`; имя модели = `name` (дефолт = `id`).
* `Models`-страница настроек (`ui-settings-models`, `$PKG\dsh-web-app\cordis.patch.yml:312-313`) показывает **все**
  объявленные маршруты: «A route registered without a configurable-provider declaration has no settings address;
  it stays visible in pickers but not on this page's rows» (`README.md:142`) — для `llm-pi-ai`-маршрутов объявление есть
  (`registerConfigurableProviders`, `$PKG\dsh-llm-pi-ai\lib\index.js:2917-2926`).
* Правки из Models-страницы пишутся **в тот же** `$PROFILE\cordis.patch.yml`:
  «Changes persist through the active profile's Cordis patch» (`$PKG\dsh-settings\README.md:12`), секция адресуется
  неймспейсом `settingsNs`, а он равен **id строки**: `ctx.fiber.entry?.options.id ?? "llm-pi-ai"` (`:2864`).
  ⇒ **строку в патче надо оставить с `id: llm-pi-ai`**, иначе UI будет писать в другой неймспейс.

---

## 5. Что именно нужно, чтобы модели стали выбираемыми

Рекомендуемая архитектура (повторяет проверенный `dsh-plugin-gigachat`): **плагин = локальный OpenAI-совместимый шлюз**,
наружу — обычный маршрут `llm-pi-ai` с `api: openai-completions`. Плагин ничего не знает про `ctx.llm` и не зависит
от внутренних типов DSH; ломается только HTTP-контракт, который держим сами.

### 5.1 Пакет плагина (минимальный контракт)

`C:\lab\antigravity\plugin\package.json`:

```json
{
  "name": "dsh-plugin-antigravity",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "index.mjs",
  "exports": { ".": "./index.mjs", "./package.json": "./package.json" }
}
```

`index.mjs` — named exports (namespace-объект ESM и есть плагин; `plugin-contract.md:416-428`):

```js
export const name = 'antigravity-gateway'
export const inject = []
export const Config = { '~standard': { version: 1, vendor: 'antigravity', validate(value) { /* … */ } } }
export async function apply(ctx, config) {
  const server = await startGateway(config)          // ваш http-сервер на 127.0.0.1:PORT
  ctx.logger.info('antigravity: gateway on ' + server.url)
  return async () => { await server.close() }        // возвращённая функция = disposer фибера
}
```

Требования, вытекающие из кода: `Config` — Standard Schema v1 (`cordis\src\fiber.ts:42-62`); `apply` может быть `async`;
возврат функции регистрирует teardown; ошибка импорта/валидации у необязательной строки — это warning, приложение живёт
(`$PKG\dsh-app-boot\README.md:98-111`). HTTP-сервер поднимать в `ctx.effect(...)` или через возвращаемый disposer
(образец — `$PKG\dsh-host-webserver\lib\index.js:410-492`).

### 5.2 Строка плагина в патче (append в конец `$PROFILE\cordis.patch.yml`)

```yaml
# Antigravity: локальный OpenAI-совместимый шлюз к моделям Antigravity.
- insert:
    - id: antigravity-gateway
      name: dsh-plugin-antigravity
      config:
        host: 127.0.0.1
        port: 8732          # должен совпадать с baseURL маршрута ниже
        # … остальные поля вашей Config-схемы (пути к креденшелам Antigravity, debugDir и т.п.)
```

### 5.3 Маршрут провайдера — внутри существующей строки `llm-pi-ai`

Добавляется ещё один ключ в `providers` (полный блок со всеми существующими провайдерами — §8):

```yaml
      antigravity:
        displayName: Antigravity
        api: openai-completions
        apiKeyEnv: ANTIGRAVITY_API_KEY     # ОБЯЗАТЕЛЬНО разрешимая ссылка, иначе моделей не будет в пикере (см. §7.1)
        baseURL: http://127.0.0.1:8732/v1
        timeoutMs: 300000
        streamIdleTimeoutMs: 300000
        models:
          # значения ниже — заполнить из research Antigravity-API (task-1)
          - id: <wire model id, напр. gemini-…-pro>
            name: <человеческое имя для пикера>
            contextWindow: <int>          # не задать -> молча 262144
            maxTokens: <int>              # не задать -> молча 32768
            input: [ text, image ]        # без image картинки будут отклонены
            # если модель «думает»:
            # reasoningEfforts:
            #   off:                          # пустое значение = не отправлять поле
            #   low: low
            #   high: high
```

Правила, которые проверяет `resolveRouteModels` (`$PKG\dsh-llm-pi-ai\lib\index.js:656-712`) — иначе строка не активируется:
`api` и `baseURL` обязательны для не-каталожного маршрута; `models` непустой; `id` непустые и без дублей;
`contextWindow`/`maxTokens` — положительные целые; `id` не должен совпадать с id установленного каталога, если хотите свои метаданные
(совпадёт — часть полей унаследуется из каталога).

### 5.4 Ключ (credential reference)

`apiKeyEnv` резолвится credential-seam'ом; креденшелы профиля сейчас: `LITHOS_AI_API_KEY`, `DEEPSEEK_API_KEY`,
`LOL_API_KEY`, `GNIDA_API_KEY`, `GIGACHAT_AUTH_KEY` (`$DSH_HOME\.credentials.yaml`, секция `refs`), плюс `GIGACHAT_AUTH_KEY` в `$DSH_HOME\.env`.
Для локального шлюза значение может быть любым непустым ASCII-плейсхолдером (`assertUsableApiKey`, `$PKG\dsh-llm\lib\index.js:1659-1663`):

* через Web UI: Settings → Models → строка Antigravity → вписать «dummy» в поле API key (пишется через `credentials.set`);
* или строкой в `$DSH_HOME\.env`: `ANTIGRAVITY_API_KEY=dummy` — **читается только на старте процесса**
  (для GigaChat это уже подтверждено: «`.env` читается только на старте»).

### 5.5 Порядок применения и нужен ли рестарт

| Шаг | Нужен ли рестарт | Почему |
|---|---|---|
| Правка `cordis.patch.yml` (провайдер + `models`) | **нет** | HMR следит за профильным патчем и home-патчем: «Profile and home patch changes also trigger recomposition» (`$PKG\dsh-hmr\README.md:59`), «HMR … registers the profile manifest and both user patch watches» (`:61`). `providers` помечено `.volatile()` → «Loader commits volatile-only changes in place» (`:59`), а плагин на `loader/volatile-update` пере-регистрирует маршруты (`$PKG\dsh-llm-pi-ai\lib\index.js:2957-2965`) |
| Установка новой зависимости (`pnpm add link:…`) | **да** (проще всего) | «A change confined to `package.json` is not detected» (`dsh-hmr\README.md:109`); «an install performed outside Plugin Manager takes effect at the next recomposition or restart» (`:118`). Плюс pnpm не стоит запускать по живому профилю |
| Правка кода плагина по `link:` | нет, если файлы под профилем/в linked-target | «Profile recompositions … also replace plugins whose loaded files below the profile directory changed … covers installed packages below `node_modules` and the targets of linked packages» (`dsh-hmr\README.md:49`) |
| Правка кода плагина, смонтированного абсолютным путём | да (или disable/enable строки) | такой файл вне области наблюдения HMR |

Рекомендуемая последовательность (детерминированная):

1. Закрыть DeepSeek Harness (профиль живой; pnpm-операции по живому профилю не гоняем).
2. Положить пакет в `C:\lab\antigravity\plugin\` (package.json + index.mjs + исходники).
3. `& $CLI plugin --profile desktop add link:C:\lab\antigravity\plugin` (или эквивалент через bundled pnpm из §3.3).
4. Заменить блок `llm-pi-ai` (§8) и добавить `insert` (§5.2) в `$PROFILE\cordis.patch.yml`.
   **Сначала сохранить копию файла**: `Copy-Item "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"`.
5. Добавить `ANTIGRAVITY_API_KEY` (плейсхолдер) — в `.env` до старта или через UI после.
6. Запустить DeepSeek Harness.

### 5.6 Альтернатива: свой `LlmAdapter` без HTTP-шлюза

Если не хочется второго HTTP-хопа, плагин может сам зарегистрировать маршрут:
`inject = ["llm"]`, затем `ctx.llm.registerAdapter(["antigravity"], adapter)` (`$PKG\dsh-llm\lib\index.js:1842-1861`).
Контракт адаптера — `LlmAdapter` (`:1670-1755`), минимально нужны:
`providerInfo(provider) → {id: provider, name}` (имя должно совпадать с маршрутом, иначе `INVALID_ADAPTER`, `:1874`),
`listModels(provider)` (иначе в пикере будет пусто, `:1713-1723`), `resolveModel(provider, model)`, `stream(options)`
(через `prepareCall`, `:1749-1753`), опционально `providerRetryPolicy`, `imageRequestTarget`.
Плюсы: нет петли через localhost, полный контроль над SSE/usage. Минусы: надо отдавать `StreamChunk`
(`dsh-llm` README, подсистема `docs/subsystems/llm-streaming.md`), следить за `attributionHeaders()` (`:1664-1668`),
и это API внутренний — при обновлении DSH ломается первым. `@deepseek-ai/dsh-llm` резолвится из профиля только для
`link:`-пакета (linked-root peer routing, `plugin-contract.md:207-209`); жёсткой проверки `instanceof` нет —
достаточно объекта с нужными методами. Для первой итерации **рекомендую 5.1-5.3**, а не это.

---

## 6. Как это проверить (без гадания)

### 6.1 До применения — снять базовую линию

```powershell
# 1) версия
& 'C:\Users\zxclu\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' --version   # -> 0.2.1-rc.5

# 2) состав профиля БЕЗ запуска и без вычисления !!js — но только для НЕ-desktop профиля:
& '...\dsh.cmd' --profile gigachat-test --dump-config     # проверено, exit 0
```

`--dump-config` не грузит плагины и не вычисляет `!!js` («compose the profile's patch layers … without booting or evaluating
`!!js`» — `$PKG\dsh\lib\dump-config-CWs_HdOc.js:5-12`), includes профильный патч, home-патч и `--patch`-слои (`:36-60`),
и печатает слои с комментариями `# == <источник>`. Живой пример сохранён: `research\dsh\dump-config-gigachat-test.txt`
(строка `- id: llm-pi-ai` на 85, `providers:` на 88).

Для профиля `desktop` этот путь **закрыт** (`bin.js:112`). Обходной, безопасный приём:
скопировать `package.json` + `cordis.patch.yml` в новый каталог `$DSH_HOME\profiles\desktop-check` и выполнить
`--profile desktop-check --dump-config` — получите ту же композицию, ничего не запуская
(каталог создаётся отдельно, `desktop` не трогается).

Ещё чище — **подменить `DSH_HOME`** и прогнать патч через настоящий парсер DSH, не касаясь рабочего дома.
Именно так проверен YAML из §8 этой статьи (сборка: строки 1-87 живого патча + новый блок + строки 197-243):

```powershell
$scratch = 'C:\lab\.tmp\dshhome'                     # любой каталог вне $DSH_HOME
New-Item -ItemType Directory -Force "$scratch\profiles\check" | Out-Null
Copy-Item "$env:USERPROFILE\.dsh\profiles\desktop\package.json" "$scratch\profiles\check\package.json"
# cordis.patch.yml профиля check = желаемый итоговый патч

$env:DSH_HOME = $scratch
& 'C:\Users\zxclu\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' `
    --profile check --dump-config
Remove-Item Env:DSH_HOME
```

Результат этой проверки на предложенном в §8 тексте: **exit 0**, в дампе есть `- id: llm-pi-ai` (строка 90)
и провайдер `antigravity` (203), строка шлюза `- id: antigravity-gateway` (1483).
Полный вывод: `research\dsh\dump-config-scratch-check.txt`. Это доказывает, что YAML синтаксически и семантически
композируется; валидацию **Config-схемы** (типы/обязательность полей) даёт только живой инспектор §6.2.

### 6.2 Живая проверка после применения (основная)

```
cordis_inspect_query { platform: "host", provider: "Config", method: "listConfigs",
                       input: { entry: "include:llm-pi-ai" } }
```

Ожидаемо: `"status": "schema"` (строка жива и у неё есть Config-схема), `packageDir` = путь установки, в `schema` — перечисление
`openai-completions|openai-responses|anthropic-messages`.
Словарь статусов (`$PKG\dsh-tool-cordis\README.md`, раздел про Host `Config`): `schema` — строка активна и схема есть;
`absent` — схемы у плагина нет; `tree` — группа/include-носитель; **`inactive`** — «disabled, never imported, or disposed».
То есть при ошибке импорта модуля или провалидированной конфигурации строка уйдёт из `schema` в `inactive`
(для необязательной строки это warning, приложение продолжает работать — `$PKG\dsh-app-boot\README.md:98-111`).
Полный список строк: тот же вызов без `entry` (в этом профиле 208 записей, `include:llm-pi-ai` среди них).

Дополнительно в браузере:

* Settings → **Models**: строка `Antigravity` с вашими моделями;
* композер → селектор модели: группа `Antigravity` с моделями (`displayName` = заголовок группы);
* отправить сообщение, выбрав модель → это и есть e2e-проверка маршрута.

### 6.3 Импорт-смоук плагина (до установки в профиль)

```powershell
node --input-type=module -e "const m = await import('file:///C:/lab/antigravity/plugin/index.mjs'); console.log(Object.keys(m), m.Config?.['~standard']?.validate({}))"
```

Проверяет ровно то, что читает Loader: именованные экспорты `name/Config/apply` (+ `inject`) и что `Config` — Standard Schema v1
(`$PKG\cordis\src\fiber.ts:42-62`). Приём из прошлой сессии: `plugin-contract.md:954-969`.

### 6.4 Проверка шлюза отдельно (до DSH)

```powershell
Invoke-RestMethod http://127.0.0.1:8732/v1/models | ConvertTo-Json -Depth 6
```

Это тот же `GET {baseURL}/models`, который использует discovery в `llm-pi-ai`
(`lib\index.js:2232-2414`; `openai-completions`/`openai-responses` — `GET {baseURL}/models` с bearer).

### 6.5 Логи

* Необязательная строка с ошибкой импорта/валидации: **только stderr Host-процесса**, файла для обычных warning'ов нет;
  фатальные — `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-host.log` (`plugin-contract.md:1043-1071`).
* Установка pnpm: `$PROFILE\.plugin-manager\logs\operation-*\pnpm.log` (при установке через `dsh plugin` — вывод в консоль).
* Проверка «строка точно не отвалилась» = п.6.2 (статус `schema`).

---

## 7. Риски и подводные камни

1. **`MISSING_CREDENTIAL` прячет модели из пикера.** `listModels` при неразрешимой ссылке возвращает `[]`
   (`$PKG\dsh-llm-pi-ai\lib\index.js:1887-1896`), а пустой каталог = «No models available»
   (`dsh-client-ui-model-selection\README.md:34`). Локальный шлюз без ключа всё равно требует **плейсхолдер**
   `apiKeyEnv` (или `headers.Authorization`): «a keyless local server needs a placeholder credential referenced by
   `apiKeyEnv` or an `Authorization` entry in `headers`» (`llm-pi-ai\README.md:254`). Это самая частая причина
   «провайдер есть, моделей нет».
2. **Патч заменяет `config` целиком.** Забыли `lithos-ai`/`gigachat` в новом блоке — они исчезнут вместе с моделями
   (а `gigachat` ещё и молча, без ошибки: маршрутов просто нет). Всегда переносите блок целиком (§8).
3. **Не вставлять вторую строку `llm-pi-ai`.** `id` строки = `settingsNs` (`:2864`) и цель override. Вторая строка
   с тем же модулем: (а) UI будет писать в чужой неймспейс, (б) две строки зарегистрируют одни и те же имена маршрутов →
   `DUPLICATE_ADAPTER` (`dsh-llm\lib\index.js:1872`). Правильно — **править существующую** строку `id: llm-pi-ai`.
4. **Имя маршрута.** Не берите id из каталога pi-ai: `google`, `google-vertex`, `anthropic`, `openai`, `deepseek`,
   `openrouter`, `azure`, `amazon-bedrock`, `mistral`, `groq`, `xai`, `zai`, `moonshotai`, `qwen-token-plan*`, `xiaomi*` и др.
   (`lib\index.js:2601-2792`). Такой маршрут «прирастёт» к каталожному провайдеру (его endpoint/аутентификация/модели),
   а не станет вашим. `antigravity` свободен.
5. **Молчаливые дефолты вместимости.** Не указали `contextWindow`/`maxTokens` — получите 262144/32768
   (`:1057-1058`), и токен-счёт/компакция будут считать неверно. Модальности: без `input: [text, image]` картинки
   отклоняются до отправки (under-claim by design, `llm-pi-ai\README.md:252-253`).
6. **`baseURL` — корень OpenAI API.** SDK добавит `/chat/completions`; без `/v1` (если шлюз так смонтирован) получите 404
   на каждом запросе. Проверять `GET {baseURL}/models` до подключения к DSH.
7. **Один заголовок перебивается: `user-agent`.** `attributionHeaders()` возвращает ровно `{ "user-agent": … }`
   (`$PKG\dsh-llm\lib\index.js:877-879`), и `requestHeaders` вытесняет ваше значение с тем же именем в любом регистре
   (`$PKG\dsh-llm-pi-ai\lib\index.js:1816-1824`); «nothing can suppress attribution entirely» (`dsh-llm:849-879`).
   Всё остальное, включая `Authorization`, из ваших `headers` доезжает до запроса; но из UI `headers` не редактируются.
8. **UI и ручные правки — один файл.** Models-страница пишет путь-операциями в `cordis.patch.yml`; одновременная правка
   файла руками → `settings/conflict` (`settings-models\README.md:94`). Не редактируйте патч при открытой карточке провайдера.
9. **`agent-default-model` не трогаем.** Строка 82-87 задаёт только дефолт новых сессий (`deepseek-official`/`deepseek-flash`);
   выбор Antigravity в пикере сохраняется в сессии/настройке выбора и правки этой строки не требует. Менять её — только если
   нужен дефолт по умолчанию для всех новых сессий.
10. **Версии pnpm.** Раньше профиль был записан pnpm 11.7.0; сейчас `.modules.yaml` уже `pnpm@11.28.5` — совпадает с bundled,
    поэтому риск перезаписи lockfile снизился, но PATH-pnpm (если он другой) по профилю всё равно не гонять: только `$CLI plugin`
    или bundled `node+pnpm`.
11. **Обратная совместимость конфига.** Ключи `provider` (переехал в ключ словаря), `maxRetries`, `maxRetryDelayMs`
    теперь **отвергаются** с явной ошибкой (`llm-pi-ai\lib\index.js:1096-1100`), `providers`-массив — тоже (`:1118`).
    Если копируете конфиг из старых заметок — перепроверьте.
12. **`cordis.yml` не редактировать** — генерируется лаунчером (`profile-boot-C14i-8IN.js:120-127`).
    Битый `cordis.patch.yml` Desktop может отложить в `.bak-<timestamp>` (`plugin-contract.md:1004-1007`) — ещё причина
    сделать свою копию перед правкой.
13. **`.env` читается только на старте**, а `credentials.yaml` — на лету. Плейсхолдер ключа, добавленный в `.env`
    после запуска, не подхватится до перезапуска (для GigaChat это уже наблюдалось).
14. **Это не «полный провайдер» для остального UI.** `llm-pi-ai`-маршрут виден в пикере и в Models, но каталог моделей,
    `reasoningEfforts` и прочие «редакторские» поля ограничены схемой (`llm-pi-ai\README.md:236-260`); заголовки, timeout'ы,
    retryPolicy в UI не редактируются — только `cordis.patch.yml`.

---

## 8. Приложение A — полный блок `llm-pi-ai` для замены строк **88-196**

Копировать в `$PROFILE\cordis.patch.yml` вместо текущих строк 88-196 (все существующие провайдеры сохранены;
новый — последним). Значения Antigravity — заполнить по итогам research (task-1).

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      lithos-ai:
        apiKeyEnv: LITHOS_AI_API_KEY
        api: openai-completions
        baseURL: https://api.lithosai.cloud/v1
        models:
          - id: deepseek-ai/DeepSeek-V4.1-Flash
            name: deepseek-ai/DeepSeek-V4.1-Flash
            contextWindow: 1024000
            input:
              - text
              - image
          - id: deepseek-ai/DeepSeek-V4.1-Flash-fast
            name: deepseek-ai/DeepSeek-V4.1-Flash-fast
          - id: deepseek-ai/DeepSeek-V4.1-Flash-ultra
            name: deepseek-ai/DeepSeek-V4.1-Flash-ultra
          - id: deepseek-ai/DeepSeek-V4.1-Flash-ultra-chat
            name: deepseek-ai/DeepSeek-V4.1-Flash-ultra-chat
          - id: zai-org/GLM-5.3
            name: zai-org/GLM-5.3
          - id: zai-org/GLM-5.3-Flash
            name: zai-org/GLM-5.3-Flash
            contextWindow: 1000000
            input:
              - text
              - image
          - id: zai-org/GLM-5.3-Flash-ultra
            name: zai-org/GLM-5.3-Flash-ultra
            input:
              - text
              - image
          - id: zai-org/GLM-5.3-Flash-ultra-chat
            name: zai-org/GLM-5.3-Flash-ultra-chat
          - id: zai-org/GLM-5.3-ultra-chat
            name: zai-org/GLM-5.3-ultra-chat
          - id: moonshotai/Kimi-K3
            name: moonshotai/Kimi-K3
          - id: moonshotai/Kimi-K3-fast
            name: moonshotai/Kimi-K3-fast
          - id: moonshotai/Kimi-K3-ultra
            name: moonshotai/Kimi-K3-ultra
          - id: moonshotai/Kimi-K3-ultra-chat
            name: moonshotai/Kimi-K3-ultra-chat
          - id: deepseek-ai/DeepSeek-V4.1-Flash-0910
            name: deepseek-ai/DeepSeek-V4.1-Flash-0910
          - id: deepseek-ai/DeepSeek-V4.1-Flash-0910-fast
            name: deepseek-ai/DeepSeek-V4.1-Flash-0910-fast
          - id: deepseek-ai/DeepSeek-V4.1-Flash-0910-ultra
            name: deepseek-ai/DeepSeek-V4.1-Flash-0910-ultra
      lol:
        api: openai-responses
        baseURL: http://127.0.0.1:1234/v1
        models:
          - id: qwen3.5-9b-uncensored-hauhaucs-aggressive
            name: pizda
            input:
              - text
              - image
        apiKeyEnv: LOL_API_KEY
      gnida:
        api: openai-completions
        baseURL: https://deuce-sprint-footsie.ngrok-free.dev/v1
        models:
          - id: colab
            name: colaab
        apiKeyEnv: GNIDA_API_KEY
      # GigaChat через локальный шлюз dsh-plugin-gigachat (порт 8731):
      # OAuth, российские корневые сертификаты, трансляция tools <-> functions.
      gigachat:
        displayName: GigaChat
        api: openai-completions
        apiKeyEnv: GIGACHAT_AUTH_KEY
        baseURL: http://127.0.0.1:8731/v1
        timeoutMs: 300000
        streamIdleTimeoutMs: 300000
        models:
          - id: GigaChat-3-Ultra
            name: GigaChat 3 Ultra
            contextWindow: 128000
            maxTokens: 8192
            input: [ text ]
          - id: GigaChat-3-Pro
            name: GigaChat 3 Pro
            contextWindow: 128000
            maxTokens: 8192
            input: [ text ]
          - id: GigaChat-3-Lightning
            name: GigaChat 3 Lightning
            contextWindow: 128000
            maxTokens: 8192
            input: [ text ]
          - id: GigaChat-2-Max
            name: GigaChat 2 Max
            contextWindow: 128000
            maxTokens: 8192
            input: [ text ]
          - id: GigaChat-2-Pro
            name: GigaChat 2 Pro
            contextWindow: 128000
            maxTokens: 8192
            input: [ text ]
          - id: GigaChat-2
            name: GigaChat 2
            contextWindow: 128000
            maxTokens: 8192
            input: [ text ]
      # Antigravity (Google) через локальный OpenAI-совместимый шлюз dsh-plugin-antigravity.
      # Base URL/порт/модели/вместимости — из C:\lab\antigravity\docs\api.md (task-1).
      antigravity:
        displayName: Antigravity
        api: openai-completions
        apiKeyEnv: ANTIGRAVITY_API_KEY    # плейсхолдер обязателен, иначе listModels() вернёт []
        baseURL: http://127.0.0.1:8732/v1
        timeoutMs: 300000
        streamIdleTimeoutMs: 300000
        models:
          - id: __FILL_MODEL_ID_1__
            name: __FILL_DISPLAY_NAME_1__
            contextWindow: __FILL_INT__
            maxTokens: __FILL_INT__
            input: [ text, image ]
          # - id: __FILL_MODEL_ID_2__
          #   name: __FILL_DISPLAY_NAME_2__
          #   contextWindow: __FILL_INT__
          #   maxTokens: __FILL_INT__
          #   input: [ text, image ]
```

## 9. Приложение B — что нужно взять из research Antigravity (task-1)

| Для DSH нужно | Откуда |
|---|---|
| `baseURL` шлюза и порт | выбирает Lead при реализации шлюза (рекомендуется `127.0.0.1:8732`, `/v1`) |
| точные wire id моделей | `models[].id` — ровно то, что шлюз принимает в поле `model` |
| человеческие имена | `models[].name` (иначе в пикере будет id) |
| context window / max output | `models[].contextWindow` / `maxTokens` |
| поддержка картинок | `models[].input: [text, image]` |
| уровни рассуждений | `models[].reasoningEfforts` (ключи `off|minimal|low|medium|high|xhigh|max`), `false` для нерассуждающих |
| нестандартные поля запроса | `compat` (например `thinkingFormat`, `maxTokensField`, `supportsReasoningEffort`) |

## 10. Приложение C — индекс доказательств

| Утверждение | Источник |
|---|---|
| Версия DSH 0.2.1-rc.5 | `$ASAR\dsh\package.json:4`; `& $CLI --version` |
| packageDir `llm-pi-ai` | живой `cordis_inspect_query` (Config.listConfigs, entry `include:llm-pi-ai`) → `research\dsh\live-config-schema-llm-pi-ai.json` |
| `name`/`inject` пакета | `$PKG\dsh-llm-pi-ai\lib\index.js:2815-2816` |
| `Config` = словарь `providers`, volatile | `…\lib\index.js:1083`, `:1118` |
| schema `profile` (все поля) | `…\lib\index.js:1049-1081` |
| поля `models[]` | `…\lib\index.js:1035-1046` |
| `compat` (все switch-и) | `…\lib\index.js:995-1022` |
| допустимые `api` | `…\lib\index.js:834-838`, `:847-849` |
| `headers` + валидация + merge | `…\lib\index.js:1060`, `:1102-1108`, `:1816-1824`, `:1989` |
| `timeoutMs` → pi-ai, `maxRetries: 0` | `…\lib\index.js:1074`, `:1754-1766` |
| `streamIdleTimeoutMs` = 300000 + watchdog | `…\lib\index.js:943`, `:1076`, `:1957-2009` |
| обязательность `api`/`baseURL`/`models` для нового маршрута | `…\lib\index.js:656-712` (`:678`, `:689-692`) |
| дефолты 262144/32768/`["text"]` | `…\lib\index.js:958-972`, `:1057-1059` |
| `MISSING_CREDENTIAL` → пустой `listModels` | `…\lib\index.js:1887-1896`, `:2892-2899` |
| `displayName` → имя группы пикера | `…\lib\index.js:1137`, `:1878-1883` |
| `settingsNs` = id строки | `…\lib\index.js:2864` |
| пере-регистрация по `loader/volatile-update` | `…\lib\index.js:2957-2965` |
| отказ от старых ключей (`provider`, `maxRetries`) | `…\lib\index.js:1096-1100` |
| реестр адаптеров / `DUPLICATE_ADAPTER` | `$PKG\dsh-llm\lib\index.js:1842-1861`, `:1872` |
| `listProviders()` из реестра | `$PKG\dsh-llm\lib\index.js:1908-1910` |
| GUI требует `listModels` | `$PKG\dsh-llm\lib\index.js:1713-1723` |
| `llm/adapters-updated` | `$PKG\dsh-llm\lib\index.js:1819-1828`, `:1895-1903`, `:1941` |
| контракт `LlmAdapter` | `$PKG\dsh-llm\lib\index.js:1670-1755` |
| строка `llm-pi-ai` в базовом бандле | `$PKG\dsh-base\cordis.patch.yml:135-136` |
| `hmr` включён, `root: []` | `$PKG\dsh-base\cordis.patch.yml:27-32` |
| пикер: `ctx.modelDirectories`, `session.models`, refetch | `$PKG\dsh-client-ui-model-selection\README.md:34`, `:76` |
| строки UI в web-app | `$PKG\dsh-web-app\cordis.patch.yml:312-313`, `:412-413` |
| Models-страница: правки в профильный патч | `$PKG\dsh-settings\README.md:12`; `$PKG\dsh-client-ui-settings-models\README.md:94` |
| `headers` не редактируются из UI | `$PKG\dsh-client-ui-settings-models\README.md:56` |
| HMR: патчи, package.json, recomposition | `$PKG\dsh-hmr\README.md:49`, `:59`, `:61`, `:109`, `:118` |
| `--dump-config` без бутa и `!!js` | `$PKG\dsh\lib\dump-config-CWs_HdOc.js:5-12`, `:36-60` |
| статусы Config-инспектора (`schema`/`absent`/`inactive`/`tree`) | `$PKG\dsh-tool-cordis\README.md` (Host `Config` provider) |
| запрет профиля `desktop` в CLI | `$PKG\dsh\lib\bin.js:35-37`, `:112`; `plugin` разрешён carrier'ом — `:119` + `$PKG\dsh-desktop-host\lib\cli.js` (`manageDesktopProfile: true`) |
| установка только бандлов | `$PKG\dsh-plugin-manager\lib\index.js:2072-2077` |
| каталожные id pi-ai (занятые имена) | `$PKG\dsh-llm-pi-ai\lib\index.js:2601-2792` |
| `link:`/абсолютный путь/peer-routing | `C:\lab\gigachat\docs\plugin-contract.md:104-138`, `:185-209`, `:766-799` |
| семантика патча (config заменяется) | `plugin-contract.md:926-952`; `$PKG\dsh-app-boot\lib\index.js:61-110` |

## 11. Приложение D — артефакты разведки

| Файл | Что |
|---|---|
| `C:\lab\antigravity\research\dsh\live-config-schema-llm-pi-ai.json` | живая проекция JSON Schema Config строки `llm-pi-ai` (198 КБ), из неё же `packageDir` |
| `C:\lab\antigravity\research\dsh\live-service-catalog.txt` | живой каталог Host-сервисов (`llm.listProviders/listModels/…`) |
| `C:\lab\antigravity\research\dsh\dump-config-gigachat-test.txt` | `dsh --profile gigachat-test --dump-config` — доказательство, что приём с копией профиля работает и как выглядит композиция |
| `C:\lab\antigravity\research\dsh\dump-config-scratch-check.txt` | `DSH_HOME=C:\lab\.tmp\dshhome`, `--profile check --dump-config` на итоговом патче из §8 → exit 0 (`llm-pi-ai` стр. 90, `antigravity` стр. 203, `antigravity-gateway` стр. 1483) |
| `C:\lab\antigravity\research\dsh\validated-patch-check.yml` | ровно тот текст патча, который прошёл этот дамп (живой патч с заменёнными строками 88-196 + новыми строками); scratch-каталог после проверки удалён |
| `C:\lab\antigravity\research\dsh\asar-cat.js` | read-only хелпер: печатает файл из `app.asar` (`node asar-cat.js /dsh/node_modules/@deepseek-ai/<pkg>/<file>`) |
