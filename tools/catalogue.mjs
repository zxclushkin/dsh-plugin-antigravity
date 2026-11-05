// language: JavaScript (ESM), file: tools/catalogue.mjs, runtime: Node >= 20
// Print the live Antigravity model catalogue as JSON. Needs a real Antigravity install
// (it reads the credential store and calls fetchAvailableModels once).
//   node tools/catalogue.mjs > research/catalogue.json
import { createAntigravityClient } from '../plugin/src/antigravity.mjs';

const client = createAntigravityClient({ log: (message) => console.error('[catalogue] ' + message) });
const { models, defaultModelId } = await client.fetchModels();
const NOT_CHAT = /^(tab_|chat_)|-image$|-tiered$/i;
const out = Object.values(models)
  .filter((model) => !NOT_CHAT.test(model.id))
  .map((model) => ({
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow || null,
    maxTokens: model.maxTokens || null,
    input: model.supportsImages ? ['text', 'image'] : ['text'],
    thinking: model.supportsThinking,
    provider: model.provider || null,
  }))
  .sort((a, b) => a.id.localeCompare(b.id));
console.log(JSON.stringify({ defaultModelId, count: out.length, models: out }, null, 2));
