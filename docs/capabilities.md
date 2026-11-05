# Antigravity `v1internal`: живая карта возможностей (Google AI features)

Что **реально работает** на этом эндпоинте, что «принято, но игнорируется», а что отвергается.
Всё ниже — результат живых вызовов 2026-11-05 (аккаунт `zxclushkin@gmail.com`, тир `free-tier`
«Antigravity», `project=aicode-consumers`, `regionCode=KG`, модели `gemini-3-flash`,
`claude-sonnet-5-5-low`, `gemini-3.1-flash-image`). Сырые сэмплы — `research\caps\samples\`.

Секреты не печатаются. Envelope тот же, что в `docs\api.md`:
`POST https://daily-cloudcode-pa.googleapis.com/v1internal:<method>` с телом
`{model, project?, request:{contents, tools, toolConfig, generationConfig, systemInstruction}}`,
заголовки `Authorization: Bearer …`, `Content-Type: application/json`,
`User-Agent: antigravity/2.29.0` (**обязательно** содержит `antigravity`).
SSE: `data: {"response":<GenerateContentResponse>}`, разделитель `\r\n\r\n`, дельты.

---

## 0. Сводка (одна строка на функцию)

| # | Функция | Статус | Как это выглядит на проводе | OpenAI chat-completions |
|---|---|---|---|---|
| A1 | `topK`, `topP`, `temperature`, `seed`, `stopSequences` | ✅ работает | как в Gemini | `top_k`(ext)/`top_p`/`temperature`/`seed`/`stop` |
| A2 | `presencePenalty`, `frequencyPenalty` | ❌ 400 `Penalty is not enabled for this model` | — | **вырезать** из запроса |
| A3 | `candidateCount>1` | ❌ 400 `Only one candidate can be specified` | — | `n` всегда 1 |
| A4 | `responseMimeType` **без** схемы | ⚠️ принято, не влияет | — | полагаться только на схему |
| A5 | `responseMimeType`+`responseSchema` | ✅ работает (Gemini) | `generationConfig.responseSchema` (верхний регистр типов) | `response_format:{type:'json_schema',json_schema:{schema}}` → транслировать |
| A6 | `responseSchema` на Claude/GPT-OSS | ❌ 400 | — | только для Gemini-моделей |
| A7 | `thinkingConfig.thinkingBudget` | ✅ работает (0 → 400) | `{thinkingBudget: -1..N}` | `reasoning_effort` → budget/level |
| A8 | `thinkingConfig.thinkingLevel` | ✅ LOW/MEDIUM/HIGH (=бюджеты) | `{thinkingLevel:'HIGH'}` | `reasoning_effort` |
| A9 | `includeThoughts` | ⚠️ игнорируется (мысли всегда в потоке) | — | всегда отдавать в `reasoning_content` |
| A10 | `mediaResolution` | ⚠️ принято, игнорируется (текст) | — | игнорировать |
| A11 | `responseModalities`, `speechConfig` | ⚠️ принято, игнорируется на текстовых; для картинок см. C | — | аудио-выхода нет |
| B1 | `tools:[{googleSearch:{}}]` | ✅ работает, есть `groundingMetadata` | см. §2 | `annotations[]` (`url_citation`) + свой блок `grounding` |
| B2 | `googleSearchRetrieval` (старое имя) | ⚠️ принято, игнорируется | — | не использовать |
| B3 | `tools:[{googleMaps:{}}]` | ⚠️ принято, метаданных нет | — | не использовать |
| B4 | `tools:[{urlContext:{}}]` | ⚠️ принято, не выполняется (нет `urlContextMetadata`) | — | не использовать |
| B5 | `tools:[{codeExecution:{}}]` | ⚠️ принято, **не исполняется** (нет `executableCode`) | — | code interpreter недоступен |
| B6 | `googleSearch` + `functionDeclarations` | ❌ 400 (даже с `includeServerSideToolInvocations`) | — | нельзя одновременно |
| C1 | Генерация изображений (`gemini-3.1-flash-image`) | ✅ работает → `inlineData(image/jpeg)` | `responseModalities:['TEXT','IMAGE']` | assistant-часть `image_url` (data URL) |
| C2 | Правка изображения (img-in → img-out) | ✅ работает | `inlineData` на вход + `responseModalities` | вход `image_url`, выход `image_url` |
| C3 | `imageConfig.aspectRatio` | ⚠️ принято; на успешных кадрах пропорция ≈16:9 (1:1 и 9:16 проверить не удалось — упёрлись в 429) | — | игнорировать |
| D1 | Вход: `image/png|jpeg` | ✅ | `parts[].inlineData{mimeType,data}` | `image_url` (data URL) |
| D2 | Вход: `audio/wav|mp3` | ✅ реально слышит | то же | `input_audio` → inlineData |
| D3 | Вход: `application/pdf` | ✅ реально читает текст | то же | `file`/свой маппинг |
| D4 | Вход: `video/mp4` | ✅ реально смотрит | то же | `video_url`-подобный → inlineData |
| D5 | Вход: `text/plain` inlineData | ✅ | то же | — |
| D6 | Вход: `fileData` (Files API/GCS/URL) | ❌ 400/403 (нужен `FileService.RegisterFile`) | — | только inline |
| E1 | `countTokens` | ✅ `{request:{contents}}` → `{totalTokens}` | см. §5 | `tiktoken`-аналог |
| E2 | `embedContent`, `generateImages`, `predict`, `batchGenerateContent` | ❌ 404 нет роута | — | эмбеддингов нет |
| F1 | `safetyRatings`, `promptFeedback.blockReason` | ❌ не приходят никогда (на этих моделях) | — | отказа нет в метаданных, только текст |
| F2 | Отказы модели | ✅ 200 + `finishReason:STOP` + текст отказа | — | обычный `content` |
| F3 | `citationMetadata` | ✅ при цитировании | `{citations:[{startIndex,endIndex,uri}]}` | `annotations[]` |
| F4 | `finishReason: RECITATION` | ✅ + `finishMessage`, `content:{}` | — | `finish_reason:'content_filter'` |
| F5 | `usageMetadata` | ✅ только 4 поля | см. §6 | `usage` (+`reasoning_tokens`) |
| G1 | Число `functionDeclarations` | ✅ ≥256 | — | без лимита сверху |
| G2 | `maxOutputTokens` | Gemini: ≥100000 принимается; Claude: ровно 128000; GPT-OSS: ≥32769 | — | клампить по вендору |
| G3 | Размер `inlineData` | ✅ ≥41.6 МБ base64 (31.2 МБ raw) | — | ограничение — только контекст |

---

## 1. Методика

* Модели: `gemini-3-flash` (основная), `claude-sonnet-5-5-low`, `gpt-oss-120b-medium`,
  `gemini-3.1-flash-image`.
* Каждый кейс — отдельный вызов `streamGenerateContent?alt=sse`; сырой запрос+ответ сохранён в
  `research\caps\samples\<кейс>.json` (`requestBody`, `responseEvents`, `summary`).
* Скрипты: `research\caps\A-generation-config.mjs`, `A2-structured-and-thinking.mjs`,
  `A3-thought-visibility.mjs`, `B-tools.mjs`, `B2-server-side-invocations.mjs`,
  `B3-combos.mjs`, `C-imagegen.mjs`, `C2-imagegen-success.mjs`, `D-multimodal-input.mjs`,
  `D2-media-limits.mjs`, `E-rpc-surface.mjs`, `E2-rpc-details.mjs`, `F-metadata.mjs`,
  `G-limits.mjs`, `H-shapes.mjs`.
* Важно: сервер **строго** валидирует JSON — любое неизвестное поле даёт
  `400 Invalid JSON payload received. Unknown name "x" at 'request.…': Cannot find field.`
  Это критично для OpenAI-совместимого шлюза: все «чужие» параметры надо вырезать до отправки.

---

## 2. A. `generationConfig` — по одному полю

| Поле | Вердикт | Наблюдение |
|---|---|---|
| `maxOutputTokens` | ✅ | работает; см. ограничения §7-G2 |
| `temperature` | ✅ | 0 и 2 принимаются (но детерминизма при `temperature:0` **нет**) |
| `topP` | ✅ | принимается |
| `topK` | ✅ | 1 и 40 принимаются |
| `seed` | ✅ **детерминизм** | два одинаковых запроса с `seed:42` → **идентичный** текст |
| `stopSequences:["blue"]` | ✅ | обрезал ответ (`"Red green "`) |
| `presencePenalty` | ❌ 400 | `"Penalty is not enabled for this model"` |
| `frequencyPenalty` | ❌ 400 | то же |
| `candidateCount:2` | ❌ 400 | `"Only one candidate can be specified in the current model"` |
| `responseMimeType:'application/json'` | ⚠️ принято, **не влияет** | модель вернула ` ```json … ``` `, а не чистый JSON |
| `responseMimeType`+`responseSchema` | ✅ см. ниже | чистый JSON, парсится |
| `responseJsonSchema` (camel) | ⚠️ принято, **игнорируется** | ответ — обычный текст; правильное имя поля — `responseSchema` |
| `mediaResolution:'MEDIA_RESOLUTION_LOW|HIGH'` | ⚠️ принято, игнорируется | на тексте эффекта нет (для картинок не проверялось детально) |
| `responseModalities:['TEXT']` / `['TEXT','IMAGE']` | ⚠️ на текстовых моделях игнорируется | `gemini-3-flash` c `[TEXT,IMAGE]` вернул **SVG-текст**, а не изображение |
| `speechConfig`+`responseModalities:['AUDIO']` | ⚠️ принято, игнорируется | аудио-выхода нет |
| неизвестное поле (`unknownFieldXyz`) | ❌ 400 | `Unknown name "unknownFieldXyz" at 'request.generation_config'` |

### 2.1 Structured output (главное для «всех функций»)

Работает **только** на Gemini-моделях и **только** при `responseSchema`
(одного `responseMimeType` недостаточно).

```json
"generationConfig": {
  "maxOutputTokens": 800,
  "responseMimeType": "application/json",
  "responseSchema": {
    "type": "OBJECT",
    "properties": {
      "title":  { "type": "STRING" },
      "year":   { "type": "INTEGER" },
      "genres": { "type": "ARRAY", "items": { "type": "STRING" } },
      "rating": { "type": "NUMBER" },
      "director": { "type": "OBJECT", "properties": { "name": { "type": "STRING" }, "born": { "type": "INTEGER" } }, "required": ["name"] },
      "mood":   { "type": "STRING", "enum": ["happy","dark","neutral"] }
    },
    "required": ["title","year","genres","mood"]
  }
}
```

Ответ — обычная SSE-строка текста, содержимое парсится `JSON.parse`:

```json
{ "title": "Inception", "year": 2010, "genres": ["Action","Sci-Fi","Thriller"], "mood": "dark",
  "director": { "name": "Christopher Nolan", "born": 1970 } }
```

Проверено: вложенные объекты, массивы, `enum`, `NUMBER`/`INTEGER` — соблюдаются;
`enum` реально ограничивает значение. Ошибки:
* `type:"BANANA"` → `400 Invalid value at 'request.generation_config.response_schema.type' … "BANANA"`;
* пустая схема `{}` → 200, но без ограничений;
* Claude + `responseSchema` → `400 tool_choice: type "tool" and "any" are not supported for this model`;
* GPT-OSS + `responseSchema` → `400 Expected the 'name' of a(n) 'json_schema' 'response_format' to be non-empty`.

### 2.2 Thinking: `thinkingBudget` vs `thinkingLevel`

Обе ручки работают и **реально меняют** объём размышлений (метрика —
`usageMetadata.thoughtsTokenCount`, а также текстовые `thought:true` части).

| Конфиг (`gemini-3-flash`, задача 837×213) | `thoughtsTokenCount` | thought-части | ответ |
|---|---|---|---|
| без `thinkingConfig` | 0 | 1 пустая | 178281 ✅ |
| `thinkingBudget:128` | 0 | 1 | 178281 ✅ |
| `thinkingBudget:512` | 0 | 1 | 178281 ✅ |
| `thinkingBudget:2048` | 337 | 7 | 178281 ✅ |
| `thinkingBudget:-1` (авто) | 382 | — | 178281 ✅ |
| `thinkingLevel:'LOW'` | 0 | 1 | 178281 ✅ |
| `thinkingLevel:'MEDIUM'` | 284 | — | 178281 ✅ |
| `thinkingLevel:'HIGH'` | 419 | 8 | 178281 ✅ |
| `thinkingBudget:0` | — | — | **400** |
| `includeThoughts:true/false` | не влияет | мысли приходят **в любом случае** | — |

Выводы для плагина:
* `thinkingLevel` = грубая ручка, мапится на бюджет: LOW → фактически «почти без мыслей»,
  MEDIUM ≈ бюджет ~1 тыс., HIGH ≈ ~2 тыс.;
* малые бюджеты (≤512) на лёгких задачах вообще не включают размышления — это нормально;
* `includeThoughts` **не работает**: thought-части приходят всегда, их надо либо
  показывать как `reasoning_content`, либо отбрасывать на клиенте;
* `thinkingBudget:0` отвергается — «выключить мышление» через 0 нельзя, только отсутствием
  `thinkingConfig` (тогда мыслей 0 на лёгких задачах, но у `gemini-3.8-*` они всё равно могут быть);
* у think-моделей при маленьком `maxOutputTokens` весь бюджет уходит в мысли →
  пустой `text` + `finishReason:MAX_TOKENS` (ставить ≥1024).

---

## 3. B. Серверные инструменты

### 3.1 `googleSearch` — ✅ единственный реально работающий серверный тул

```json
"tools": [{ "googleSearch": {} }]
```

Ответ (Gemini) получает `candidate.groundingMetadata`:

```json
{
  "webSearchQueries": ["who won the most recent F1 world championship", "latest F1 world champion"],
  "searchEntryPoint": { "renderedContent": "<style>.container{…}</style>…" },
  "groundingChunks": [
    { "web": { "uri": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQ…",
               "title": "wikipedia.org" } }
  ],
  "groundingSupports": [
    { "segment": { "endIndex": 170, "text": "The most recent Formula 1 World Drivers' Championship was won by Kimi Antonelli…" },
      "groundingChunkIndices": [0, 1, 2] }
  ]
}
```

* реально ходит в поиск: `webSearchQueries` содержат фактические запросы, ответ содержит
  актуальные факты (в этом окружении — «Kimi Antonelli, 2026»);
* `searchEntryPoint.renderedContent` — готовый HTML-виджет Google (можно игнорировать);
* `groundingChunks[].web.uri` — **redirect-URL** `vertexaisearch.cloud.google.com`, не исходник;
* связь «фрагмент ответа → источники» — через `groundingSupports[].groundingChunkIndices`
  (индексы в `groundingChunks`).

Маппинг в OpenAI: `annotations: [{type:'url_citation', url: chunk.web.uri, title: chunk.web.title, start_index, end_index}]`
(индексы брать из `groundingSupports[].segment`), плюс — при желании — нестандартный блок
`grounding: {web_search_queries, sources}`.

### 3.2 Что НЕ работает (принято молча, без ошибок)

| Тул | Ответ | Что в теле |
|---|---|---|
| `googleSearchRetrieval` (устаревшее имя) | 200 | нет `groundingMetadata`, модель отвечает «нет доступа в интернет» |
| `googleMaps` | 200 | нет никаких метаданных (ни `groundingMetadata`, ни maps-полей) |
| `urlContext` | 200 | нет `urlContextMetadata`, модель отвечает «не могу открыть интернет» |
| `codeExecution` | 200 | **нет** `executableCode`/`codeExecutionResult` — код не исполняется, модель просто пишет python-код в тексте |
| `tools:[{}]` | 200 | no-op |

`codeExecution`-части (`executableCode`, `codeExecutionResult`) не появились ни разу за все пробы.

### 3.3 Комбинации

| Комбинация | Результат |
|---|---|
| `googleSearch` + `urlContext` | 200, работает поиск (grounding есть), urlContext проигнорирован |
| `codeExecution` + `googleSearch` | 200, grounding есть, код не исполняется |
| **`googleSearch` + `functionDeclarations`** | **400**: `Please enable tool_config.include_server_side_tool_invocations to use Built-in tools with Function calling.` |
| то же + `toolConfig:{includeServerSideToolInvocations:true}` | **всё равно 400** (флаг принимается как валидное поле, но комбинацию не разрешает) |
| флаг внутри `functionCallingConfig` | 400 `Unknown name "includeServerSideToolInvocations" at 'request.tool_config.function_calling_config'` |
| `tools:[{unknownTool:{}}]` | 400 `Unknown name "unknownTool" at 'request.tools[0]'` |
| `googleSearch` + `responseSchema` | 200, JSON соблюдён, но `groundingMetadata` **нет** (поиск подавлен structured output) |
| `googleSearch` на Claude/GPT-OSS | 200, тул игнорируется (модель отвечает «не могу проверить»), метаданных нет |

Итог: **grounding и function-calling взаимоисключающи**. Плагину нужен выбор:
либо `tools` для агента, либо `googleSearch` для ответов с цитатами.

---

## 4. C. Генерация и правка изображений

Единственная image-модель в каталоге: `imageGenerationModelIds: ["gemini-3.1-flash-image"]`
(`displayName: "Gemini 3.1 Flash Image"`, `maxTokens: 65536`, mimeTypes: png/jpeg/heic/webp).

Запрос:

```json
{
  "model": "gemini-3.1-flash-image",
  "project": "aicode-consumers",
  "request": {
    "contents": [{ "role": "user", "parts": [{ "text": "A red apple on a white table, soft studio light." }] }],
    "generationConfig": { "maxOutputTokens": 4096, "responseModalities": ["TEXT", "IMAGE"] }
  }
}
```

Ответ — два SSE-события:

```
event#0 parts = ["thoughtSignature", "inlineData"]
   inlineData: mimeType="image/jpeg", data=<base64>, 444132 B (≈592 k символов base64)
   thoughtSignature: ≈836 672 символа (!) — приклеена к части с картинкой
event#1 finish=STOP parts = ["text"]      // короткое текстовое описание
usage: {promptTokenCount:13, candidatesTokenCount:1535, totalTokenCount:1548}
```

* **mimeType всегда `image/jpeg`** (PNG на выходе не отдаётся), размеры примеров:
  `1408×768`, `1376×768` — то есть практически всегда 16:9, независимо от запрошенного
  `imageConfig.aspectRatio`.
* `inlineData.data` — чистый base64 без префикса `data:`; для OpenAI `image_url` нужно
  собрать `data:image/jpeg;base64,<…>`.
* Правка изображения работает: `inlineData` (png) на входе + `responseModalities:['TEXT','IMAGE']`
  → `inlineData(image/jpeg)` на выходе (130 КБ).
* Работает и в `streamGenerateContent?alt=sse`, и в `generateContent` (не-stream).
* `gemini-3-flash` с `responseModalities:['TEXT','IMAGE']` картинку **не** генерирует
  (возвращает SVG/текст) — нужна именно image-модель.
* `imageConfig:{aspectRatio:'1:1'|'16:9'|…}` принимается (нет 400), но соотношение
  не соблюдается; `'7:3'` не проверялся из-за квоты.

### 4.1 Главная ловушка: «успешная» неудача

При неудаче генерации сервер отвечает **HTTP 200** и валидным SSE, но контента нет:

```json
{"response":{"candidates":[{"content":{},"finishMessage":"Unable to show the generated image.
The model could not generate the image based on the prompt provided. You will not be charged for
this request. Try rephrasing the prompt. If you think this was an error, [send feedback](…)"}]}}
```

То же самое при `finishReason: RECITATION` (§6). Плагин обязан считать «пустой ответ»
ошибкой и смотреть `finishMessage`.

Доля успеха в пробах: 3 из 6 промптов (остальные — пустой `content`).
Дальше упёрлись в `429`: генерация картинки стоит ~1500 выходных токенов
(`candidatesTokenCount:1535`), квота image-модели расходуется заметно.

---

## 5. D. Мультимодальный вход (`inlineData`)

Формат части: `{"inlineData":{"mimeType":"<mime>","data":"<base64 без префикса>"}}`.

| Вход | Вердикт | Доказательство |
|---|---|---|
| `image/png` (96×96 синий квадрат) | ✅ | «What color?» → `"Blue"` |
| `image/png`, объявленный как `image/jpeg` | ✅ | mime — подсказка, содержимое снифается → тоже `"Blue"` |
| `audio/wav` (речь, SAPI TTS) | ✅ реально слышит | «Transcribe exactly» → `"The Secret Files with Bell and Elphant 9"` (искажено, но фраза узнана) |
| `audio/mp3` (та же речь) | ✅ | → `"The Secret Phrase is BLUELPHANT9."` |
| `application/pdf` (текст «secret word is ORANGE-42») | ✅ реально читает | → `"ORANGE-42"` |
| `video/mp4` (1 с, чёрный кадр 64×64 H.264) | ✅ | → `"I see a black screen."` |
| `text/plain` | ✅ | → прочитал `ALPHA-7` |
| мусор как `image/png` | ❌ 400 | `Unable to process input image. Please retry or report in …/troubleshooting` |
| мусор как `audio/wav` | ❌ 400 | `INVALID_MEDIA` (reason в `ErrorInfo`) |
| `fileData` с `https://` | ❌ 400 | `Cannot fetch content from the provided URL.` |
| `fileData` с `gs://` | ❌ 400 | `Referencing Google Cloud Storage files directly is not supported. Register them using FileService.RegisterFile first.` |
| `fileData` с Files-API URI | ❌ 403 | `You do not have permission to access the File abc or it may not exist.` |

**Размеры (валидные PNG, измерено):**

| raw | base64 | результат | время |
|---|---|---|---|
| 0.64 МБ | 0.85 МБ | 200 | 1.2 с |
| 2.54 МБ | 3.38 МБ | 200 | 3.7 с |
| 6.17 МБ | 8.23 МБ | 200 | 3.4 с |
| 10.11 МБ | 13.48 МБ | 200 | 10.6 с |
| 16.28 МБ | 21.71 МБ | 200 | 11.6 с |
| 21.7 МБ | 28.9 МБ | 200 | 8.7 с |
| **31.2 МБ** | **41.6 МБ** | **200** | 21.6 с |

Байтового лимита в районе 20 МБ **нет** (в отличие от публичного Gemini API); ограничение —
контекст модели (`maxTokens`) и время запроса. Практично: держать один запрос ≤ ~20 МБ
ради таймаутов, а не из-за жёсткого лимита.

`fileData`/Files API для нас закрыт → только inline.

---

## 6. E. RPC-поверхность `v1internal`

Полный список 65 имён из строк `language_server.exe` — `samples/v1internal-methods.txt`.
Фактическая доступность (проверено POST-ом с правдоподобным телом):

| Метод | Статус | Детали |
|---|---|---|
| `loadCodeAssist` | ✅ 200 | тир + `cloudaicompanionProject` |
| `fetchAvailableModels` | ✅ 200 | динамический каталог |
| `retrieveUserQuota` | ✅ 200 | бакеты по моделям |
| `retrieveUserQuotaSummary` | ✅ 200 | **окна 5h + weekly** по группам |
| `streamGenerateContent` | ✅ 200 | основной |
| `generateContent` | ✅ 200 | не-stream |
| `countTokens` | ✅ 200 | **только** `{request:{contents:[…]}}` → `{totalTokens:2}`; с `model` внутри `request` → 404 |
| `rewriteUri` | ✅ 200 | `{}` → `{}` |
| `fetchUserInfo` | ✅ 200 | `{userSettings:{telemetryEnabled:true}, regionCode:"KG"}` |
| `listExperiments` | ✅ 200 | список experiment id |
| `generateChat`, `streamGenerateChat`, `completeCode`, `searchSnippets`, `checkUrlDenylist`, `listModelConfigs` | ⚠️ роут есть (400, не 404) | ни один из опробованных конвертов (`{request:…}`, `{contents}`, `{model,contents}`, `{messages}`) не подошёл — прото-схема неизвестна, для плагина бесполезно |
| `embedContent`, `batchEmbedContents` | ❌ 404 | эмбеддингов нет вообще (все 5 конвертов → HTML 404) |
| `generateImages`, `predict`, `batchGenerateContent` | ❌ 404 | отдельных image/predict/batch эндпоинтов нет — картинки только через `generateContent`/`streamGenerateContent` с image-моделью |
| `getCodeAssistGlobalUserSetting`, `onboardUser` | ❌ 404 | роут не смонтирован |

Квоты (из `retrieveUserQuotaSummary`):

```json
{"groups":[
 {"displayName":"Gemini Models","description":"Models within this group: Gemini Flash, Gemini Pro",
  "buckets":[{"bucketId":"gemini-weekly","window":"weekly","remainingFraction":0.528,…},
             {"bucketId":"gemini-5h","window":"5h","remainingFraction":0.979,…}]},
 {"displayName":"<3p>","buckets":[{"bucketId":"3p-weekly",…},{"bucketId":"3p-5h",…}]}
]}
```

То есть два независимых лимита на группу: **5-часовой** и **недельный**; отдельные группы для
Google-моделей и third-party (Claude/GPT-OSS). Это то, что надо отдавать в UI вместо
привычного «осталось запросов».

---

## 7. F. Метаданные ответа и безопасность

`usageMetadata` — только четыре поля, других не встречалось ни в одном из ≈600 событий:

```
promptTokenCount, candidatesTokenCount, totalTokenCount, thoughtsTokenCount
```

Нет `cachedContentTokenCount`, нет `toolUsePromptTokenCount` (prompt caching через этот
эндпоинт не подтверждён).

**Безопасность реализована отказом модели в тексте, а не метаданными.** На провокационные
запросы (бомба, самоповреждение, пытки, травля) — `200`, `finishReason:STOP`,
`promptFeedback` отсутствует, `safetyRatings` отсутствует, текст:

```
"I cannot fulfill this request. I am programmed to strictly prohibit providing instructions …"
```

`promptFeedback.blockReason` и `candidate.safetyRatings` не появились **ни разу** — на этом
эндпоинте их, судя по всему, не заполняют (или фильтр не срабатывает для данных моделей).

Что реально приходит:

* `candidate.citationMetadata` (при цитировании защищённого текста):

```json
{ "citations": [ { "startIndex": 70, "endIndex": 292,
                   "uri": "https://arz.wikipedia.org/wiki/…" } ] }
```

  Маппинг в OpenAI: `annotations[{type:'url_citation', url: citation.uri, start_index, end_index}]`.

* `finishReason` наблюдаемые: **STOP**, **MAX_TOKENS**, **RECITATION**.
  `SAFETY` не воспроизведён (блокировка идёт отказом в тексте).
* При обрыве по фильтру: последнее событие — `{"content":{},"finishReason":"RECITATION",
  "finishMessage":"The generated content was filtered because it may contain material that
  resembles existing copyrighted works. …"}`. Тот же паттерн «пустой content + finishMessage»,
  что и у неудачной генерации картинки.
  Для OpenAI: `finish_reason:'content_filter'`, а `finishMessage` — в `error`/`annotations`.

---

## 8. G. Лимиты (измерено)

| Что | Результат |
|---|---|
| число `functionDeclarations` | 1, 16, 32, 64, 128, **256** — все 200, вызов инструмента работает; жёсткого лимита не нашли |
| `maxOutputTokens` Gemini (`gemini-3-flash`) | 1 и 65536 и 65537 и **100000** → 200 (каталог заявляет 65536, сервер не режет) |
| `maxOutputTokens` Claude | 128000 → 200; **128001 → 400** (жёсткий предел Anthropic) |
| `maxOutputTokens` GPT-OSS | 32768 и **32769** → 200 (каталог 32768) |
| текст промпта | 2 700 000 символов (~675 k токенов) → 200; контекст ~1 M токенов |
| `inlineData` | ≥41.6 МБ base64 (31.2 МБ raw) → 200 |
| image-модель | ~1535 выходных токенов за картинку; после 3–4 генераций — 429 |

Квоты и `429`: см. `docs\api.md` §8 (`QUOTA_EXHAUSTED`, `quotaResetTimeStamp`, `RetryInfo`),
`503 MODEL_CAPACITY_EXHAUSTED` — транзиентно, нужен backoff.

---

## 9. Как это отдать в OpenAI `chat-completions`

### 9.1 Входящий запрос (OpenAI → Antigravity)

| OpenAI поле | Что делать |
|---|---|
| `messages[].content` (string) | `contents[{role:'user'|'model', parts:[{text}]}]` |
| `messages[].content[].type='image_url'` (data URL) | `parts[{inlineData:{mimeType, data}}]` (из `data:<mime>;base64,<b64>`) |
| `messages[].content[].type='input_audio'` | `inlineData` с `mimeType:'audio/wav'|'audio/mpeg'` |
| PDF-вложение | `inlineData{mimeType:'application/pdf', data}` |
| `messages[].role='system'` | `systemInstruction:{parts:[{text}]}` (не в `contents`!) |
| `messages[].tool_calls` / `tool`-сообщения | `functionCall` part (роль `model`) + `functionResponse{name,id,response}` (роль `user`); **Gemini требует вернуть `thoughtSignature`**, Claude — `id` |
| `tools[]` (function) | `tools[{functionDeclarations:[{name,description,parameters}]}]` |
| `tool_choice:'auto'|'required'|'none'` | `toolConfig.functionCallingConfig.mode = AUTO|ANY|NONE` (+`allowedFunctionNames` для конкретной функции) |
| `temperature`,`top_p`,`stop`,`seed` | 1:1 (`stopSequences`) |
| `max_tokens`/`max_completion_tokens` | `generationConfig.maxOutputTokens`, **клампить**: Claude ≤128000, GPT-OSS ≤32768, Gemini ≤65536 |
| `n` | всегда 1 (иначе 400) |
| `presence_penalty`,`frequency_penalty`,`logprobs`,`top_logprobs`,`logit_bias`,`user` | **вырезать** — иначе 400 `Unknown name …` |
| `response_format:{type:'json_schema', json_schema:{schema}}` | **только Gemini**: `responseMimeType:'application/json'` + `responseSchema:<schema>` (перевести типы в верхний регистр); для Claude/GPT-OSS — либо не поддерживать, либо tool-forcing |
| `reasoning_effort` | `thinkingConfig.thinkingLevel` = LOW/MEDIUM/HIGH (или `thinkingBudget` = 512/2048/-1); `maxOutputTokens` ≥1024 |
| `stream:true` | `streamGenerateContent?alt=sse`; иначе `generateContent` |
| `stream_options.include_usage` | usage и так приходит на каждом событии (накопительно) — отдавать последним чанком |

### 9.2 Исходящий ответ (Antigravity → OpenAI)

| Antigravity | OpenAI |
|---|---|
| `parts[].text` (`thought:false`) | `choices[0].delta.content` (дельты, склеивать) |
| `parts[].thought:true` + `usageMetadata.thoughtsTokenCount` | `delta.reasoning_content` (и `usage.completion_tokens_details.reasoning_tokens`) |
| `parts[].functionCall{name,args,id}` | `delta.tool_calls[{index,id,type:'function',function:{name,arguments:JSON.stringify(args)}}]`; `id` — с `thoughtSignature` (упакованной в id, как в текущем плагине) |
| `candidate.groundingMetadata` | `annotations[{type:'url_citation',url,title,start_index,end_index}]` + (опц.) `grounding:{web_search_queries}` |
| `candidate.citationMetadata.citations[]` | `annotations[{type:'url_citation',url,start_index,end_index}]` |
| `parts[].inlineData{image/jpeg}` | assistant-часть `{type:'image_url', image_url:{url:'data:image/jpeg;base64,…'}}`; **`thoughtSignature` у этой части отбрасывать** (≈800 k символов!) |
| `finishReason:STOP` | `finish_reason:'stop'` |
| `finishReason:MAX_TOKENS` | `finish_reason:'length'` |
| `finishReason:RECITATION` + `finishMessage` | `finish_reason:'content_filter'` |
| пустой `content:{}` + `finishMessage` (в т.ч. неудачная картинка) | ошибка/`finish_reason:'error'` — **не отдавать пустой успешный ответ** |
| `usageMetadata` | `usage:{prompt_tokens, completion_tokens, total_tokens, completion_tokens_details:{reasoning_tokens}}` |
| HTTP 400 `Unknown name` | `400 invalid_request_error` (сообщение сервера проксировать) |
| HTTP 401 / 403 (#3501, scope) | `401`/`403` (сообщение важно: «войдите в Antigravity») |
| HTTP 429 `QUOTA_EXHAUSTED` | `429` + `Retry-After` из `quotaResetDelay`/`RetryInfo.retryDelay` |
| HTTP 503 `MODEL_CAPACITY_EXHAUSTED` | `503` + retry |

---

## 10. Чего в Antigravity API НЕТ (для «всех функций Google AI»)

1. **Веб-поиск с выдачей источников есть**, но только как единственный серверный тул
   (несовместим с function-calling).
2. **Grounding через Google Maps** — не работает (нет метаданных).
3. **URL/страницы (`urlContext`) не читаются** — модель не ходит по ссылкам.
4. **Code execution отсутствует** — `executableCode`/`codeExecutionResult` не приходят.
5. **Эмбеддингов нет** (`embedContent` → 404).
6. **Отдельного image/predict/batch API нет** — картинки только как части
   `generateContent`/`streamGenerateContent` у `gemini-3.1-flash-image`.
7. **Аудио-выхода (TTS) нет** — `responseModalities:['AUDIO']`/`speechConfig` игнорируются.
8. **Files API/GCS/URL-референсы недоступны** — только `inlineData`.
9. **`safetyRatings`/`promptFeedback` не приходят** — фильтры проявляются отказом в тексте
   и `finishReason:RECITATION` с `finishMessage`.
10. **Prompt caching не подтверждён** — в `usageMetadata` нет `cachedContentTokenCount`.
11. **`n>1` невозможно**, penalties запрещены, `responseJsonSchema` (camel) не работает.

---

## 11. Что доказано LIVE vs INFERRED

**LIVE (живые вызовы 2026-11-05):** всё в таблицах §2–§8: поля `generationConfig`
(работает/400/игнор), structured output с вложенной схемой, thinking-бюджеты и
`thoughtsTokenCount`, невидимость `includeThoughts`, `googleSearch`+`groundingMetadata`+
`groundingSupports`, неработоспособность `googleMaps`/`urlContext`/`codeExecution`/
`googleSearchRetrieval`, 400 на `googleSearch`+`functionDeclarations` (и что флаг не помогает),
генерация и правка изображений (`inlineData image/jpeg`, `thoughtSignature` 836 k символов,
пустые `content`+`finishMessage`), входы `png/jpeg/wav/mp3/pdf/mp4/text` и реальное понимание
речи/PDF/видео, отказ `fileData`, размеры `inlineData` до 41.6 МБ base64, промпт 2.7 M символов,
`countTokens`, 404 на `embedContent`/`generateImages`/`predict`/`batchGenerateContent`,
`retrieveUserQuotaSummary` (окна 5h/weekly, группы Gemini/3p), `regionCode:KG`,
`safetyRatings`/`promptFeedback` отсутствуют, `RECITATION`+`finishMessage`, `citationMetadata`,
лимиты `maxOutputTokens` по вендорам, 256 tools.

**INFERRED (не проверено исчерпывающе):**
* верхняя граница `inlineData` — между 41.6 МБ и, вероятно, лимитом HTTP; больше не гоняли;
* точная семантика `thinkingLevel` → внутренний бюджет (выведена из `thoughtsTokenCount`);
* `imageConfig.aspectRatio` — принимается, но соотношение не соблюдалось на 1 успешном кейсе
  (16:9 запросили → 1376×768); возможно, влияет только на некоторые значения — не проверено
  из-за 429;
* `mediaResolution` для картинок (влияние на качество/токены) — не измерялось;
* `finishReason:SAFETY` не воспроизведён (блокировки идут отказом в тексте);
* `generateChat`/`streamGenerateChat`/`completeCode` — роуты живы (400, не 404), но прото-схема
  неизвестна; возможно, доступны через другой конверт (в бинарнике рядом с ними —
  `cloudcode.pkg.modelproxy`);
* квоты `3p-*` относятся к Claude/GPT-OSS — по названию и совпадению `resetTime`, точно не
  проверялось.

---

## 12. Как воспроизвести

```powershell
cd C:\lab\antigravity\research\caps
node A-generation-config.mjs          # поля generationConfig
node A2-structured-and-thinking.mjs   # responseSchema + thinking
node A3-thought-visibility.mjs        # видны ли thought-части, includeThoughts
node B-tools.mjs                      # googleSearch / maps / urlContext / codeExecution
node B2-server-side-invocations.mjs   # флаг include_server_side_tool_invocations, цитаты
node B3-combos.mjs                    # все варианты флага + grounding&schema
node C-imagegen.mjs                   # генерация изображений
node C2-imagegen-success.mjs          # успешность/aspectRatio/размеры
node D-multimodal-input.mjs           # png/wav/mp3/pdf/mp4/text + мусор
node D2-media-limits.mjs              # речь через SAPI + лимиты размера
node E-rpc-surface.mjs                # какие v1internal:* живые
node E2-rpc-details.mjs               # quota summary, userinfo, конверты chat-методов
node F-metadata.mjs                   # safety/citations/finishReason/usage
node G-limits.mjs                     # tools/maxOutputTokens/inlineData/промпт
node H-shapes.mjs                     # форма inlineData-части, fileData
```

Сырые сэмплы (без секретов): `research\caps\samples\*.json` + изображения `img_*.jpg`,
фикстуры `samples\fixtures\`. Список 65 методов: `samples\v1internal-methods.txt`.

**Гигиена секретов:** токены живут только в памяти процесса; auth берётся из
`../probe.mjs` (`getAccessToken`), client_secret не хранится в файлах.
