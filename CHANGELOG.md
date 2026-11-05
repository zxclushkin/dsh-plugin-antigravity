# Changelog

## 0.3.0 — built-in image generation tool

The adapter now also registers a harness **tool**, so image generation is available to *any*
model in the agent instead of only to the image model in the picker — the way the Antigravity
IDE's own agent uses its built-in imageGen.

- `image_generate` tool (`src/tool.mjs`): `prompt`, `aspect_ratio` (enum), `count` (1–4);
  returns saved absolute paths and a markdown image reference rendered by the chat UI.
- `src/imagegen.mjs`: calls the account's built-in image model
  (`imageGenerationModelIds` → `gemini-3.1-flash-image`) with
  `responseModalities: ["TEXT","IMAGE"]` + `imageConfig`, saves the JPEG, and turns the
  endpoint's HTTP-200-with-`finishMessage` refusals into real failures.
- Config: `features.imageGen`, `features.imageModel`, `features.imageAspectRatios`,
  `features.imageMaxOutputTokens`; `plugin.inject` is now `['llm','tools']`.
- Verified end-to-end through `dsh headless`: the agent called `image_generate` and produced a
  1024×1024 JPEG in one turn; offline checks grew to 21.

## 0.2.0 — native LLM adapter

Rewritten from a local OpenAI-compatible gateway + `llm-pi-ai` route into a **native harness
LLM adapter**: `ctx.llm.registerAdapter(['antigravity'], adapter)` streams the harness
`StreamChunk` protocol directly. No HTTP hop, no OpenAI wire format, no model list to maintain —
the picker is built from the live Antigravity catalogue.

- Adapter contract: `providerInfo`, `providerRetryPolicy`, `listModels`, `resolveModel`,
  `prepareCall`, `stream`, `imageRequestTarget`, with zero imports from the installation
  (absolute-path mount cannot resolve `@deepseek-ai/*`).
- Harness chunks: text, reasoning (`Thinking` block), tool-call deltas with JSON arguments,
  usage (incl. cached tokens), terminal finish reasons; failures carry harness `code`/`failure`
  facts through the documented cross-package seam.
- Gemini protocol: system instructions, alternating contents, image attachments resolved via
  the harness attachment service, tool declarations (no-argument tools declared without
  `parameters`), `thoughtSignature` replay encoded in the tool-call id, thinking levels/budgets.
- Google AI features that actually work on the private endpoint: structured output
  (`responseSchema`), Google Search grounding (turns without tools), image generation and image
  editing, image input, live model catalogue (17 chat + image models on the test account).
- Explicit non-features of the endpoint are documented instead of faked: `googleMaps`,
  `urlContext`, `codeExecution`, `includeThoughts`, safety metadata, embeddings, penalties,
  `n>1`, `fileData`.
- `tools/apply-profile.mjs` now installs a single managed block and no longer touches
  `llm-pi-ai`; it also refuses to pick a backup that mentions Antigravity when `--pristine` is
  requested, so unrelated profile edits are never reverted.
- Tests: 18 offline checks, 10 live checks; verified end-to-end through `dsh headless`
  (text and a full agent tool loop).

## 0.1.0 — initial gateway

Local OpenAI-compatible gateway in front of Antigravity's `v1internal` API, registered as an
`llm-pi-ai` provider route. Superseded by 0.2.0.
