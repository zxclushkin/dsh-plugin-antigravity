# Antigravity → plain Node.js: как вызывать модели Google Antigravity напрямую

Разведка upstream-API для плагина DSH. Всё ниже проверено на этой машине
(`zxclu`, Windows 11, Node 24.16) **живыми запросами** 2026-11-05, при **выключенном**
приложении Antigravity. Секреты в документе замаскированы (`первые6…последние4`);
рабочий `probe.mjs` достаёт их из установленного бинарника сам.

---

## 0. TL;DR

```js
// 1) refresh_token берём из Windows Credential Manager: target "gemini:antigravity"
// 2) обмениваем на access_token (client_id/secret — из language_server.exe)
// 3) POST https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse
const body = {
  model: 'gemini-3-flash',                    // id из fetchAvailableModels
  project: 'aicode-consumers',                // из loadCodeAssist (можно опустить)
  request: {                                  // обычный Gemini GenerateContentRequest
    contents: [{ role: 'user', parts: [{ text: 'Привет' }] }],
    generationConfig: { maxOutputTokens: 1024 },
  },
};
// headers ОБЯЗАТЕЛЬНО: Authorization: Bearer <access_token>
//                       Content-Type: application/json
//                       User-Agent: antigravity/2.29.0   ← без слова "antigravity" будет 403 #3501
```

Ответ — SSE: `data: {"response": <GenerateContentResponse>, "traceId": "...", "metadata": {}}`,
разделитель **CRLF** (`\r\n\r\n`), `[DONE]` **нет**, текстовые части — **дельты** (склеивать).

Готовый рабочий модуль: `C:\lab\antigravity\research\probe.mjs`
(`node probe.mjs list | ask "…" [model] | tool [model] | info`).

---

## 1. Что установлено (инвентарь)

| Что | Путь | Факт |
|---|---|---|
| Приложение | `C:\Users\zxclu\AppData\Local\Programs\Antigravity` | `Antigravity.exe` 245 737 472 B, app v2.29.0 (лог `main.log:1274`) |
| Версия сборки | `…\Antigravity\version` | `44.5.1` (Electron/Chromium), не версия продукта |
| Electron-shell | `…\Antigravity\resources\app.asar` | 4 797 365 B, 1092 файла, **только** `dist/*.js` — логики моделей НЕТ |
| Движок агента | `…\Antigravity\resources\bin\language_server.exe` | **187 342 336 B**, Go, LS v2.29.0 — именно он ходит в Google |
| MCP-хелпер | `…\resources\app.asar.unpacked\node_modules\chrome-devtools-mcp` | распакован отдельно |
| Данные приложения | `C:\Users\zxclu\AppData\Roaming\Antigravity` | `logs\main.log`, `logs\language_server.log`, `app_storage.json` (33 KB, состояние UI) |
| Каталог пользователя | `C:\Users\zxclu\.gemini` | `oauth_creds.json`, `antigravity\daemon\hub_*.json`, `antigravity_state.pbtxt`, `brain\` (транскрипты) |
| Учётка | Credential Manager | target `gemini:antigravity` → OAuth-токены IDE |

`app.asar` читается скриптами `research\tmp\asar2.mjs` (свой мини-ридер asar; заголовок
начинается с `{"files"` на смещении 16, данные — с 289 528). Логика OAuth/моделей — **только**
внутри Go-бинарника (строки `auth_provider.go`, `server_oauth.go`, `keyring.go`,
`model_config_manager.go`, `http_helpers.go`).

Кто с кем говорит (подтверждено логами):

```
Antigravity.exe (Electron) ──spawn──> language_server.exe (Go, LS 2.29.0)
      UI-окно                            ├─ OAuth (refresh/access token)
                                         ├─ gRPC/HTTP на localhost (random port)
                                         └─ HTTPS → daily-cloudcode-pa.googleapis.com
```

Прямые вызовы к Google из Node работают **без запущенного приложения** — проверено:
на момент всей разведки процессов `Antigravity`/`language_server` не было (см. §11).

---

## 2. Аутентификация

### 2.1 OAuth-клиент приложения

Достаётся из строк `language_server.exe`. В бинарнике лежат **три** пары
client_id/client_secret; для обновления refresh-токена работает **только одна**:

```
client_id     = 1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com
client_secret = GOCSPX…qDAf               ← 28 символов, полное значение в бинарнике
```

Не рабочие пары (для refresh отдают `401 invalid_client` / `401 unauthorized_client`):

```
1098991175725-mdu1oe5cbbe1ckggsebobh94toiap657.apps.googleusercontent.com
884354919052-36trc1jjb3tguiac32ov6cod268c5blh.apps.googleusercontent.com
```
(и три секрета `GOCSPX…ZtsX`, `GOCSPX…W4-5` — не подходят к рабочим id).

Поэтому **не хардкодьте секрет**: `probe.mjs` при старте потоково (чанки 4 МБ) сканирует
бинарник регексами `\d{10,}-[a-z0-9]{15,}\.apps\.googleusercontent\.com` и
`GOCSPX-[A-Za-z0-9_-]{28}`, получает 3×3 = 9 пар и подбирает рабочую первым успешным
refresh (~1 попытка из 9, ≈0.3 с). Переопределение: env `ANTIGRAVITY_CLIENT_ID` /
`ANTIGRAVITY_CLIENT_SECRET`.

### 2.2 Где лежит refresh_token

**Windows Credential Manager** (Generic credential). Проверено `cmdkey /list` + `CredReadW`:

| Target | Размер | Содержимое |
|---|---|---|
| `gemini:antigravity` | 598 B | JSON, **основной источник** |
| `antigravity.plugins:u83548f9c074d2695/oauth2:91da520010abcd0a@1` | 485 B | второй OAuth-набор (плагинная подсистема), тоже refresh-абелен тем же клиентом |
| `…/@1_IDENTITY` | 20 B | `zxclushkin@gmail.com` |
| `…/_ACCOUNTS` | 5 B | `["1"]` |

Структура blob `gemini:antigravity`:

```json
{
  "token": {
    "access_token": "ya29.a…0213",              // 260 символов, живёт 3599 с
    "token_type": "Bearer",
    "refresh_token": "1//0fV…UUA0",             // 103 символа, долгоживущий
    "expiry": "2026-11-04T20:30:00.5484975+03:00",  // ВНИМАНИЕ: 7 знаков дробной части
    "expires_in": 3599
  },
  "auth_method": "consumer",
  "id_token_email": "zxclushkin@gmail.com",
  "writer_id": "Prw5lS…k4pA"
}
```

`Date.parse()` в Node **не понимает** 7 дробных цифр — обрезать до 3:
`String(expiry).replace(/\.(\d{3})\d+/, '.$1')` (это делает `probe.mjs`).

### 2.3 Почему `C:\Users\zxclu\.gemini\oauth_creds.json` не подходит

Там лежит токен **gemini-CLI** (`azp`/`aud` = `681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j`,
scopes `cloud-platform userinfo.email userinfo.profile openid`). Его refresh-токен
принадлежит другому OAuth-клиенту: с нашими секретами → `401 unauthorized_client`,
а его access_token не даёт scope `aicode` → Cloud Code отвечает
`403 ACCESS_TOKEN_SCOPE_INSUFFICIENT`. **Не использовать.** (Наличие файла — просто след
установленного gemini-cli, Antigravity IDE им не пользуется: у неё токен в keyring.)

### 2.4 Refresh: точный запрос и ответ

```http
POST https://oauth2.googleapis.com/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token
&refresh_token=<из keyring>
&client_id=1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com
&client_secret=GOCSPX…qDAf
```

Ответ `200`:

```json
{ "access_token": "ya29.a…", "expires_in": 3599, "scope": "...", "token_type": "Bearer", "id_token": "eyJ…" }
```

Факты (проверено):
* выданные scopes: `aicode`, `cclog`, `cloud-platform`, `experimentsandconfigs`,
  `userinfo.email`, `userinfo.profile`, `openid`;
* `refresh_token` в ответе **не приходит** → ротации нет; один и тот же RT обновлялся
  ≥6 раз подряд, остаётся валидным, сессия IDE не ломается;
* TTL access_token — 3599 с; обновлять проактивно (например, за 5 минут до истечения).

### 2.5 Чтение Credential Manager из Node (без нативных зависимостей)

Прямого API в Node нет → одноразовый PowerShell + `Add-Type`/`CredReadW` (≈400–700 мс,
делать один раз и держать в памяти). Готовый код — `probe.mjs:readKeyringCredential()`,
ключевое:

```powershell
Add-Type -TypeDefinition $src   # DllImport advapi32!CredReadW(target, type=1, flags=0)
$b = [AgCred]::Read('gemini:antigravity')
[Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($b))
```

Замечание: blob читается в user-scope; если IDE запущена от другого пользователя —
target не найдётся (`CredReadW` вернёт false).

### 2.6 Если access_token ещё жив — сеть не нужна

`probe.mjs:getAccessToken()` сначала смотрит на `token.expiry`; если до истечения >60 с —
возвращает токен из blob (source `keyring-blob`), иначе делает refresh (source `oauth-refresh`).

---

## 3. Эндпоинты

### 3.1 Хосты

| Хост | Когда используется |
|---|---|
| `https://daily-cloudcode-pa.googleapis.com` | **эта установка** — все вызовы в логах (`language_server.log:17,31,96`) |
| `https://cloudcode-pa.googleapis.com` | prod-хост, зашит в бинарнике рядом |
| `https://autopush-cloudcode-pa.sandbox.googleapis.com` | sandbox |
| `https://preprod-daily-cloudcode-pa.sandbox.googleapis.com` | sandbox |

Путь всегда `POST /v1internal:<method>` (gRPC-transcoding, тело/ответ — JSON).

### 3.2 Методы `v1internal:` (полный список из строк бинарника)

Ключевые: `loadCodeAssist`, `fetchAvailableModels`, `streamGenerateContent`, `generateContent`,
`countTokens`, `retrieveUserQuota`, `streamGenerateChat`, `generateChat`,
`internalAtomicAgenticChat`, `tabChat`, `completeCode`, `generateCode`, `rewriteUri`,
`fetchUserInfo`, `listExperiments`, `listModelConfigs`, `onboardUser`, `setUserSettings`,
`recordClientEvent`, `recordTrajectoryAnalytics`, `recordCodeAssistMetrics`,
`retrieveUserQuotaSummary`, `listAgents`, `proxyCommand`, `checkUrlAntivirus`,
`checkUrlDenylist`, `searchSnippets`, `transformCode`, `migrateDatabaseCode`,
`pollSignalingMessages`, `sendSignalingMessage`, `connectInstance`, `listInstances` и др.
(65 методов суммарно).

### 3.3 Заголовки

| Заголовок | Обязателен | Значение |
|---|---|---|
| `Authorization` | да | `Bearer <access_token>` |
| `Content-Type` | да | `application/json` |
| `User-Agent` | **да, критично** | обязан **содержать подстроку `antigravity`** (регистр не важен) |
| `X-Goog-Api-Client`, `x-goog-user-project` | нет | в бинарнике есть, для наших вызовов не требовались |

Матрица (проверено, тело и токен одинаковые):

```
antigravity/2.29.0        → 200      foo/1.0            → 403
antigravity-recon/1.0     → 200      Mozilla/5.0        → 403
antigravity               → 200      gemini-cli/1.0     → 403
ANTIGRAVITY/9             → 200      google-cloud-sdk   → 403
x/antigravity             → 200      undici (default)   → 403
```

Тело `403`: `"You do not have a valid license of this product. … (#3501)"`.
Сервер также возвращает `x-cloudaicompanion-trace-id` и `server: ESF`.

---

## 4. Служебные вызовы

### 4.1 `loadCodeAssist` — тир аккаунта и project id

```http
POST /v1internal:loadCodeAssist
{"metadata":{"pluginType":"GEMINI"}}
```

```json
{
  "currentTier": { "id": "free-tier", "name": "Antigravity", "description": "…",
                   "privacyNotice": {…}, "upgradeSubscriptionType": "GOOGLE_ONE_HELIUM" },
  "allowedTiers": [ { "id": "free-tier" }, { "id": "standard-tier" } ],
  "cloudaicompanionProject": "aicode-consumers",
  "gcpManaged": false,
  "paidTier": { "id": "g1-pro-tier", "name": "Google AI Pro", "availableCredits": […] },
  "upgradeSubscriptionUri": "https://codeassist.google.com/upgrade"
}
```

Полный образец: `research\samples\01-loadCodeAssist.json`.

### 4.2 `fetchAvailableModels` — каталог моделей **динамический**

```http
POST /v1internal:fetchAvailableModels
{}
```

Возвращает `models: { <id>: {...} }` + метаданные. **Каталог меняется между вызовами**
(в двух замерах подряд: 20 → 23 → 24 модели, менялся `defaultAgentModelId`), поэтому
в плагине список моделей нужно тянуть при старте, а не хардкодить.

Поля модели:

```json
"gemini-3-flash": {
  "displayName": "Gemini 3 Flash",
  "supportsImages": true, "supportsVideo": true, "supportsThinking": true,
  "minThinkingBudget": 128,
  "maxTokens": 1048576,          // контекст
  "maxOutputTokens": 65536,
  "thinkingLevel": 3,            // 1=low 2=medium 3=high (влияет на UI-порядок)
  "recommended": true,
  "modelProvider": "MODEL_PROVIDER_GOOGLE",   // либо …_ANTHROPIC / …_OPENAI
  "apiProvider": "API_PROVIDER_GOOGLE_GEMINI",
  "model": "MODEL_PLACEHOLDER_M18",
  "supportedMimeTypes": { "image/png": true, … 51 тип },
  "quotaInfo": { "remainingFraction": 0.9999, "resetTime": "2026-11-05T12:59:56Z" },
  "modelExperiments": { "experiments": { … } }
}
```

Верхний уровень: `defaultAgentModelId`, `agentModelSorts` (порядок для UI:
`Recommended` → claude-opus-5-5-*, claude-sonnet-5-5-*, gpt-oss-120b-medium),
`tieredModelIds` ({flashLite, flash, pro}), `commandModelIds`, `imageGenerationModelIds`,
`webSearchModelIds`, `commitMessageModelIds`, `audioTranscriptionModelIds`, `experimentIds`.
Полный образец: `research\samples\02-fetchAvailableModels.json`.

### 4.3 `retrieveUserQuota`

`POST /v1internal:retrieveUserQuota` `{}` → `{buckets:[{modelId, remainingFraction, resetTime, tokenType:"WTUS"}]}`.
Образец: `research\samples\03-quota.json`.

### 4.4 `countTokens`

`POST /v1internal:countTokens` — конверт **другой**: `{"request":{"contents":[…]}}`,
**без** `model`/`project` (иначе `400 Unknown name "model"`). Ответ: `{"totalTokens":2}`.

---

## 5. Генерация

### 5.1 Конверт запроса

```json
{
  "model": "gemini-3-flash",
  "project": "aicode-consumers",
  "request": {
    "contents": [ { "role": "user", "parts": [{ "text": "…" }] } ],
    "systemInstruction": { "parts": [{ "text": "…" }] },
    "tools": [ { "functionDeclarations": [ … ] } ],
    "toolConfig": { "functionCallingConfig": { "mode": "AUTO" } },
    "generationConfig": {
      "maxOutputTokens": 2048, "temperature": 1, "topP": 0.95, "stopSequences": ["…"],
      "thinkingConfig": { "thinkingBudget": 1024 }   // либо { "thinkingLevel": "LOW|MEDIUM|HIGH" }
    }
  }
}
```

* `request` — обычный Gemini `GenerateContentRequest` (snake_case тоже принимается).
* `project` — из `loadCodeAssist.cloudaicompanionProject` (`aicode-consumers` для free-tier).
  Проверено: **поле можно не передавать** — с `undefined`, `""` и мусорным
  `"bogus-project-xyz"` ответы те же `200`. Передавать всё равно рекомендуется.
* Имена ролей: `user` / `model`.

### 5.2 `streamGenerateContent?alt=sse`

`POST /v1internal:streamGenerateContent?alt=sse`, `Content-Type: text/event-stream`.

Каждое событие — одна строка `data: <json>`, события разделены **`\r\n\r\n`**
(встречается и `\n\n` — нормализуйте), маркера `[DONE]` нет, конец = закрытие соединения:

```
data: {"response": {"candidates":[{"content":{"role":"model","parts":[{"text":""}]}}],
        "usageMetadata":{"promptTokenCount":13,"totalTokenCount":13},
        "modelVersion":"gemini-3-flash","responseId":"qjjsarj…"},
       "traceId":"93313b5…","metadata":{}}
```

Особенности (проверено на потоке в 20 чисел и на длинных ответах):
* части `text` — **дельты**, их надо **конкатенировать** (не заменять снапшотом);
* `usageMetadata` — **накопительный** на каждом событии (`candidatesTokenCount` растёт);
* `thought: true` — куски «размышлений» (для `gpt-oss-*` и thinking-моделей), в ответ
  пользователю их отдавать не обязательно; учитываются в `thoughtsTokenCount`;
* `thoughtSignature` (base64) приходит на «содержательных» частях — **его нужно сохранять
  и возвращать** при повторной отправке истории, если в истории есть `functionCall`
  (см. §6);
* `modelVersion` может отличаться от запрошенного id (сервер вернул
  `gemini-3.8-flash-n` на запрос `gemini-3.8-flash-high`).

Образцы: `research\samples\04-sse-basic.txt`, `08-sse-deltas.txt`, `07-sse-system-instruction.sse`.

### 5.3 `generateContent` (без стрима)

Тот же конверт → один JSON-объект `{"response": <GenerateContentResponse>, "traceId": …, "metadata": {}}`.
Если вызвать `streamGenerateContent` **без** `?alt=sse` — вернётся JSON-**массив** таких же
конвертов (`application/json`).

### 5.4 Поля ответа

| Поле | Смысл |
|---|---|
| `candidates[].content.parts[].text` | текст (дельта в SSE) |
| `parts[].thought: true` | размышления |
| `parts[].thoughtSignature` | подпись, нужна для replay tools |
| `parts[].functionCall{name,args,id}` | вызов инструмента |
| `candidates[].finishReason` | `STOP`, `MAX_TOKENS`, … |
| `usageMetadata.promptTokenCount` | вход |
| `usageMetadata.candidatesTokenCount` | выход |
| `usageMetadata.totalTokenCount` | сумма |
| `usageMetadata.thoughtsTokenCount` | из них «размышления» |
| `modelVersion`, `responseId`, `traceId` | метаданные |

---

## 6. Tool calling (проверено round-trip на Gemini и Claude)

**Объявление инструментов** — как в Gemini API (типы в верхнем регистре допустимы):

```json
{"tools":[{"functionDeclarations":[{
  "name":"get_weather","description":"Get weather for a city",
  "parameters":{"type":"OBJECT","properties":{"city":{"type":"STRING"}},"required":["city"]}
}]}],
 "toolConfig":{"functionCallingConfig":{"mode":"AUTO"}}}
```

**Ответ** (Gemini, из `samples\05-sse-tools-gemini.sse`):

```json
{"parts":[{"thoughtSignature":"EmcKZQ…","functionCall":{"name":"get_weather","args":{"city":"Moscow"},"id":"call_165640"}}]}
```

**Ответ** (Claude, из `samples\06-sse-tools-claude.sse`) — без `thoughtSignature`:

```json
{"parts":[{"functionCall":{"name":"get_weather","args":{"city":"Moscow"},"id":"toolu_vrtx_018nfNL2…"}}]}
```

`finishReason` при вызове инструмента — `STOP`.

**Возврат результата (multi-turn).** Ход модели сохраняется как `role:"model"` с тем же
`functionCall` (Gemini — **обязательно с `thoughtSignature`**, иначе `400`), затем
`role:"user"` с `functionResponse`:

```json
"contents": [
  {"role":"user","parts":[{"text":"Weather in Moscow? call get_weather"}]},
  {"role":"model","parts":[{"functionCall":{"name":"get_weather","args":{"city":"Moscow"},"id":"call_165640"},
                            "thoughtSignature":"EmcKZQ…"}]},
  {"role":"user","parts":[{"functionResponse":{"name":"get_weather","id":"call_165640",
                            "response":{"result":{"tempC":-3,"sky":"snow"}}}}]}
]
```

Точные правила (оба проверены live):
* Gemini: без `thoughtSignature` в part'е `functionCall` → `400`
  `"Function call is missing a thought_signature in functionCall parts…"`;
  с подписью — `200` и осмысленный ответ (`"The weather in Moscow is currently -3°C with snow."`).
* Claude: поле `id` в `functionResponse` **обязательно** (мапится в `tool_use_id`):
  без него `400 messages.N.content.0.tool_result.tool_use_id: Field required`;
  с `id` — `200` (`"It's snowing in Moscow right now, and the temperature is -3°C."`).
  `thoughtSignature` для Claude не нужен.
* `id` в `functionResponse` для Gemini безвреден (`200`), можно передавать всегда.

---

## 7. Модели: живой каталог (2026-11-05)

Аккаунт: `zxclushkin@gmail.com`, тир `free-tier` («Antigravity»), доступен апгрейд
`g1-pro-tier` (Google AI Pro). Каталог приходит из `fetchAvailableModels`; ниже — срез
на момент разведки (23 id; полный `samples\02b-model-ids.txt`).

| model id | displayName | ctx | maxOut | thinking | provider | статус чата |
|---|---|---|---|---|---|---|
| `claude-opus-5-5-high` | Claude Opus 5.5 (High) | 1 000 000 | 128 000 | да | ANTHROPIC | 200 |
| `claude-opus-5-5-medium` | Claude Opus 5.5 (Medium) | 1 000 000 | 128 000 | да | ANTHROPIC | 200 |
| `claude-opus-5-5-low` | Claude Opus 5.5 (Low) | 1 000 000 | 128 000 | да | ANTHROPIC | 200 |
| `claude-sonnet-5-5-high` | Claude Sonnet 5.5 (High) | 1 000 000 | 128 000 | да | ANTHROPIC | 200 |
| `claude-sonnet-5-5-medium` | Claude Sonnet 5.5 (Medium) | 1 000 000 | 128 000 | да | ANTHROPIC | 200 |
| `claude-sonnet-5-5-low` | Claude Sonnet 5.5 (Low) | 1 000 000 | 128 000 | да | ANTHROPIC | 200 |
| `gpt-oss-120b-medium` | GPT-OSS 120B (Medium) | 131 072 | 32 768 | да | OPENAI | 200 (сначала `thought`, потом текст) |
| `gemini-3-flash` | Gemini 3 Flash | 1 048 576 | 65 536 | да | GOOGLE | 200 |
| `gemini-3.5-flash-lite` | Gemini 3.5 Flash Lite | 1 048 576 | 65 535 | да | GOOGLE | 200 |
| `gemini-3.8-flash-high` | Gemini 3.8 Flash (High) | 1 048 576 | 65 536 | да | GOOGLE | 200 |
| `gemini-3.8-flash-medium` | Gemini 3.8 Flash (Medium) | 1 048 576 | 65 536 | да | GOOGLE | 200 |
| `gemini-3.8-flash-low` | Gemini 3.8 Flash (Low) | 1 048 576 | 65 536 | да | GOOGLE | 200 |
| `gemini-3.8-flash-tiered` | — | 1 048 576 | 65 536 | да | GOOGLE | 200, но почти всё уходит в `thought` (нужен большой `maxOutputTokens`) |
| `gemini-3.1-flash-lite` | Gemini 3.1 Flash Lite | 1 048 576 | 65 535 | да | GOOGLE | 200 |
| `gemini-2.5-flash` | Gemini 3.5 Flash Lite | 1 048 576 | 65 535 | да | GOOGLE | 200 |
| `gemini-2.5-flash-lite` | Gemini 3.5 Flash Lite | 1 048 576 | 65 535 | да | GOOGLE | 200 |
| `gemini-2.5-flash-thinking` | Gemini 3.5 Flash Lite | 1 048 576 | 65 535 | да | GOOGLE | 200 |
| `gemini-2.5-pro` | Gemini 2.5 Pro | 1 048 576 | 65 535 | да | GOOGLE | `503 MODEL_CAPACITY_EXHAUSTED` (и раз `429`, см. §8) |
| `gemini-3.1-flash-image` | Gemini 3.1 Flash Image | 65 536 | 65 536 | нет | GOOGLE | 200 (но это image-модель; один раз был `500`) |
| `chat_20706`, `chat_23310` | — | 16 384 / 32 768 | — | нет | GOOGLE | `400` (внутренние id, не чат) |
| `tab_flash_lite_preview`, `tab_jump_flash_lite_preview` | — | 16 384 | 4 096 | нет | GOOGLE | 200 (технические, автодополнение) |

Наблюдения:
* `displayName` в этом окружении местами «съехал» (у `gemini-2.5-flash`,
  `gemini-2.5-flash-lite`, `gemini-2.5-flash-thinking` один и тот же
  «Gemini 3.5 Flash Lite») — UI должен показывать либо id, либо displayName+id.
* `modelProvider` даёт реальный вендор (GOOGLE/ANTHROPIC/OPENAI) — удобно для UI-группировки.
* Список моделей **не константа**: подтягивать `fetchAvailableModels` при старте плагина.

---

## 8. Квоты, лимиты, ошибки

Квоты — **на модель**, тип `WTUS`, reset раз в сутки (`retrieveUserQuota`, `quotaInfo.resetTime`);
в free-tier «Antigravity» остаток на момент разведки: claude ≈ 0.986, gemini ≈ 0.99993.

Карта ошибок (все тела — реальные):

| HTTP | reason / текст | Причина и что делать |
|---|---|---|
| 400 | `INVALID_ARGUMENT: Request contains an invalid argument.` | `thinkingBudget: 0`; неверный `thinkingLevel`; `chat_*` id |
| 400 | `Function call is missing a thought_signature…` | Gemini: не вернули `thoughtSignature` в part'е `functionCall` |
| 400 | `…tool_result.tool_use_id: Field required` | Claude: нет `id` в `functionResponse` |
| 401 | `UNAUTHENTICATED: Request had invalid authentication credentials …` | протух/битый access_token → refresh |
| 403 | `…insufficient authentication scopes` `ACCESS_TOKEN_SCOPE_INSUFFICIENT` | токен без scope `aicode` (например, из `~/.gemini/oauth_creds.json`) |
| 403 | `You do not have a valid license of this product … (#3501)` | `User-Agent` без подстроки `antigravity` |
| 429 | `QUOTA_EXHAUSTED` + `quotaResetDelay`, `quotaResetTimeStamp`, `RetryInfo.retryDelay`, `uiMessage:"true"` | дневная квота модели: `"You have exhausted your capacity on this model. Your quota will reset after 4h59m58s."` |
| 503 | `MODEL_CAPACITY_EXHAUSTED` (`error_number: "2010"`) | нет мощности на модель прямо сейчас — ретрай с backoff |
| 500 | без тела | напр. `gemini-3.1-flash-image` в чат-режиме |

Важно: `streamGenerateContent` отдаёт **JSON-ошибку с `Content-Type: text/event-stream`**,
поэтому при `status != 200` тело надо парсить как JSON, а не как SSE.

Thinking-параметры (проверено):

```
без thinkingConfig                 → 200
thinkingBudget: 0                  → 400 (ноль запрещён)
thinkingBudget: 1024               → 200 (thought-части приходят)
thinkingBudget: -1                 → 200 (авто)
thinkingLevel: "LOW"/"MEDIUM"/"HIGH" → 200
thinkingLevel: "THINKING_LEVEL_LOW" → 400 (не тот enum)
includeThoughts: true              → 200
```

Ловушка: у thinking-моделей при маленьком `maxOutputTokens` весь бюджет уходит в
`thoughtsTokenCount`, а `text` приходит пустым с `finishReason: MAX_TOKENS`
(воспроизводилось на `gemini-3.8-flash-tiered` при 24–32 токенах). Ставьте ≥1024.

---

## 9. Что доказано LIVE, а что INFERRED

**Доказано живыми запросами (2026-11-05, приложение Antigravity не запущено):**
1. OAuth-refresh из keyring-токена: `200`, scopes с `aicode`, TTL 3599 с, RT не ротируется.
2. `loadCodeAssist` → `200`, тир `free-tier`/«Antigravity», `project = aicode-consumers`.
3. `fetchAvailableModels` → `200`, 20/23/24 модели в трёх замерах (динамический каталог).
4. `retrieveUserQuota` → `200`, 20 бакетов WTUS.
5. `countTokens` → `200` `{"totalTokens":2}` (конверт `{request:{contents}}`).
6. `streamGenerateContent?alt=sse` → `200` для 17 моделей из 20 (см. §7; двое `chat_*` — `400`,
   `gemini-2.5-pro` — `503`), включая
   Claude 5.5 и GPT-OSS 120B; дельты текста, накопительный usage, `thoughtSignature`,
   `finishReason STOP/MAX_TOKENS`.
7. `generateContent` (без стрима) → `200`, одиночный JSON; `streamGenerateContent` без
   `?alt=sse` → JSON-массив.
8. `systemInstruction` → `200` и на Gemini, и на Claude (инструкция соблюдена).
9. Tool-call round-trip: Gemini (с `thoughtSignature`) и Claude (с `id` в `functionResponse`) —
   оба `200` с осмысленным финальным текстом.
10. `User-Agent` обязателен и должен содержать `antigravity` (матрица из 13 значений).
11. Ошибки: `400` (signature/tool_use_id/thinkingBudget 0/chat_*), `401` (битый токен),
    `403` (#3501 и scope), `429` (квота с timestamp), `503` (capacity), `500`.
12. Из логов приложения подтверждены хосты и точные пути (`language_server.log:17,31,96`),
    а также что ходит в Google именно Go-`language_server.exe` (v2.29.0).

**INFERRED (не проверено на живых вызовах, но следует из строк бинарника/логов):**
* список методов `v1internal:*` целиком (65 шт.) — взяты из строк Go-бинарника;
  протестированы только `loadCodeAssist`, `fetchAvailableModels`, `streamGenerateContent`,
  `generateContent`, `countTokens`, `retrieveUserQuota`, `fetchUserInfo` (не проверялся);
* prod-хост `cloudcode-pa.googleapis.com` и sandbox-хосты — в бинарнике есть, но эта
  установка использует `daily-cloudcode-pa`; переключение не проверялось;
* требование scope `aicode` для всех методов — проверено только на `loadCodeAssist`/
  `fetchAvailableModels` (там был 403 при чужом токене);
* точная стратегия проверки `User-Agent` (подстрока или регекс) — проверено эмпирически:
  `antigravity`, `x/antigravity`, `ANTIGRAVITY/9` работают, `antigravityX` — тоже; значит
  это скорее «содержит», чем «начинается с»;
* механизм хранения токена в keyring как единственного источника для IDE — из строк
  `keyring.go`/`auth_provider.go` + факта, что blob `gemini:antigravity` обновляется
  приложением; прямых логов записи не видели;
* срок жизни refresh_token — не проверялся (Google обычно «до отзыва»).

---

## 10. Чек-лист для автора плагина

1. **UA** обязан содержать `antigravity` — иначе 403 #3501 (самая частая ловушка).
2. **Токен**: keyring `gemini:antigravity` → `token.refresh_token` → refresh раз в ~55 мин.
   Читать keyring один раз при старте (PowerShell, ~0.5 с), дальше держать в памяти.
3. **Секрет клиента** не хардкодить: извлекать из `language_server.exe`
   (3 id × 3 секрета → подобрать рабочую пару) или из env.
4. **Модели** тянуть из `fetchAvailableModels` при старте; id/displayName/ctx/maxOut/thinking/
   provider — всё есть в ответе. Каталог меняется.
5. **Стрим**: склеивать дельты, нормализовать CRLF, не ждать `[DONE]`, usage — накопительный.
   Ошибки при `status != 200` парсить как JSON (Content-Type обманчивый).
6. **Tools**: сохранять `thoughtSignature` у Gemini-вызовов и `id` у всех `functionCall`;
   возвращать `functionResponse` c `id` (Claude — обязателен) и `thoughtSignature`
   в model-part (Gemini — обязателен). Иначе `400`.
7. **maxOutputTokens** ≥1024 для thinking-моделей, иначе пустой текст + `MAX_TOKENS`.
8. **Ретраи**: `503 MODEL_CAPACITY_EXHAUSTED` — backoff и повтор; `429` — ждать до `resetTime`.
9. **Не использовать** `~/.gemini/oauth_creds.json` (другой OAuth-клиент, нет scope `aicode`).
10. `project` передавать из `loadCodeAssist` (`aicode-consumers`), но не полагаться на него.
11. Приложение **не обязано** быть запущено: refresh + API работают headless (доказано).

---

## 11. Альтернативные пути (fallback, не основной)

Приложение поднимает Go-LS как локальный сервер и пишет рядом «hub»-файл:

```
C:\Users\zxclu\.gemini\antigravity\daemon\hub_<httpPort>.json
{ "pid": 27200, "httpsPort": 55351, "httpPort": 55352, "lsVersion": "2.29.0",
  "csrfToken": "c461d4…f41c" }                       ← csrfToken не публиковать
```

В логе: `server.go:746 Language server listening on random port at 55351 for HTTPS (gRPC)`,
`server.go:754 … 55352 for HTTP`, `server.go:3343 Wrote hub discovery file: …hub_55352.json`.
То есть запущенный LS доступен локально (gRPC/Connect + HTTP UI), но это протокол
`sdk`/Connect-Protobuf, а не чат-API, и требует запущенного приложения.

Есть встроенный CLI (тоже требует авторизованного LS):

```
"C:\Users\zxclu\AppData\Local\Programs\Antigravity\resources\bin\language_server.exe" agentapi --help
  get-conversation-metadata <id>
  new-conversation [--model=<flash_lite|flash|pro|model_id>] [--title=…] [--profile=…] <prompt>
  send-message [--title=…] <recipient_id> <content>
```

Для плагина DSH это не нужно: прямой `v1internal` REST/SSE проще, быстрее и не требует
запуска IDE.

---

## 12. Как воспроизвести

```powershell
cd C:\lab\antigravity\research
node probe.mjs info                 # что найдено в keyring/бинарнике (без секретов)
node probe.mjs list                 # живой каталог моделей + остатки квот
node probe.mjs ask "Скажи PONG" gemini-3-flash
node probe.mjs ask "Скажи PONG" claude-sonnet-5-5-low
node probe.mjs tool                 # tool-call round-trip (по умолчанию gemini-3-flash)
node probe.mjs tool claude-sonnet-5-5-low
```

Артефакты разведки:
* `research\probe.mjs` — рабочий модуль (экспортирует `getAccessToken`, `loadCodeAssist`,
  `fetchAvailableModels`, `retrieveUserQuota`, `streamGenerate`, `generate`, `rpc`).
  Секрет клиента **не хранит**: извлекает из `language_server.exe` при старте.
* `research\samples\` — сырые ответы API и SSE-потоки (без секретов), см. `samples\README.md`.
* `research\probe-discovery.mjs` — минимальный пример «loadCodeAssist + fetchAvailableModels».
* `research\tmp\` — вспомогательное: `asar2.mjs` (мини-ридер `app.asar`),
  `scan-strings.mjs` (сканер строк бинарника), сохранённые SSE-примеры.
  Одноразовые probe-скрипты этапа разведки (`probe-*.mjs`) удалены: они содержали
  литеральный `client_secret`, а их функциональность целиком покрыта `probe.mjs`.

Гигиена секретов: полные `access_token`/`refresh_token`/`client_secret` нигде в
`C:\lab\antigravity` не сохранены (проверено регекс-сканом); в документации — только
маскировка `первые6…последние4`. Токены живут только в памяти процесса `probe.mjs`.
