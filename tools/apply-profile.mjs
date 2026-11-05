// language: JavaScript (ESM), file: tools/apply-profile.mjs, runtime: Node >= 20
// Installs the Antigravity gateway into a DSH profile:
//   1. appends the `antigravity` route (all chat models of the account) to the existing
//      `- id: llm-pi-ai` entry;
//   2. appends the `- insert:` row that mounts plugin/index.mjs;
//   3. validates the result with DSH's own patcher under a scratch DSH_HOME.
//
//   node tools/apply-profile.mjs                       # dry run, writes nothing
//   node tools/apply-profile.mjs --apply               # backup + write the profile patch
//   node tools/apply-profile.mjs --apply --from=old.yml # rebuild from a pristine patch copy
//
// Environment: DSH_HOME (default ~/.dsh), DSH_PROFILE (default desktop), DSH_CLI (dsh command).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const WORK = path.join(REPO, '.tmp');

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const DSH_PROFILE = process.env.DSH_PROFILE || 'desktop';
const PROFILE_DIR = path.join(DSH_HOME, 'profiles', DSH_PROFILE);
const PATCH_FILE = path.join(PROFILE_DIR, 'cordis.patch.yml');
const SCRATCH_HOME = path.join(WORK, 'dshhome');
const GATEWAY_PORT = Number(process.env.ANTIGRAVITY_PORT || 8732);

const APPLY = process.argv.includes('--apply');
// --from=<path> builds from a pristine copy instead of the live file (upgrading an
// already-patched profile without duplicating the provider block).
const FROM = (process.argv.find((arg) => arg.startsWith('--from=')) || '').slice('--from='.length) || null;

// Absolute entry path: mounting a file needs no package install and no pnpm run in the profile.
const PLUGIN_ENTRY = path.join(REPO, 'plugin', 'index.mjs').replace(/\\/g, '/');

function findDshCli() {
  if (process.env.DSH_CLI) return process.env.DSH_CLI;
  const candidates = [
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
    '/usr/local/bin/dsh',
    '/opt/DeepSeek Harness/resources/runtime/cli/bin/dsh',
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || 'dsh';
}

async function loadCatalogue() {
  const file = path.join(REPO, 'research', 'catalogue.json');
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  }
  const { createAntigravityClient } = await import('../plugin/src/antigravity.mjs');
  const client = createAntigravityClient({ log: (message) => console.error('[catalogue] ' + message) });
  const { models } = await client.fetchModels();
  return {
    models: Object.values(models).map((model) => ({
      id: model.id,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      input: model.supportsImages ? ['text', 'image'] : ['text'],
    })),
  };
}

// Antigravity's own displayName is unreliable (it aliases gemini-2.5-flash to "Gemini 3.5
// Flash Lite"), so picker names are derived from the model id and stay truthful.
const CAP = new Set(['claude', 'gemini', 'sonnet', 'opus', 'flash', 'lite', 'pro', 'thinking', 'image']);
const cap = (word) => word[0].toUpperCase() + word.slice(1);
function prettyName(id) {
  const tokens = id.split('-');
  const words = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const next = tokens[i + 1];
    if (/^\d+$/.test(token) && /^\d+$/.test(next || '')) { words.push(token + '.' + next); i++; continue; }
    if (token === 'gpt' && next === 'oss') { words.push('GPT-OSS'); i++; continue; }
    if (/^\d+b$/i.test(token)) { words.push(token.toUpperCase()); continue; }
    if (['medium', 'high', 'low'].includes(token)) { words.push('(' + cap(token) + ')'); continue; }
    if (CAP.has(token)) { words.push(cap(token)); continue; }
    words.push(token);
  }
  return words.join(' ');
}

const NOT_CHAT = /^(tab_|chat_)|-image$|-tiered$/i;
// Models that answer but are not usable as chat models on some accounts (503 capacity).
const EXCLUDED = new Set((process.env.ANTIGRAVITY_EXCLUDE || 'gemini-2.5-pro').split(',').map((s) => s.trim()));

function modelYaml(model) {
  const lines = [
    '          - id: ' + model.id,
    '            name: ' + JSON.stringify(prettyName(model.id)),
  ];
  if (model.contextWindow) lines.push('            contextWindow: ' + model.contextWindow);
  if (model.maxTokens) lines.push('            maxTokens: ' + model.maxTokens);
  lines.push('            input: [ text, image ]');
  return lines;
}

function buildProviderLines(models) {
  const lines = [
    '      ' + MARK_BEGIN,
    '      # Google Antigravity models through the local dsh-plugin-antigravity gateway (port ' + GATEWAY_PORT + ').',
    '      # No key: the gateway reuses the credentials of the installed Antigravity app.',
    '      antigravity:',
    '        displayName: Antigravity',
    '        api: openai-completions',
    // The local gateway ignores the key, but pi-ai still insists on one; a literal
    // Authorization header satisfies it without inventing a credential reference.
    '        headers:',
    "          Authorization: 'Bearer dummy'",
    '        baseURL: http://127.0.0.1:' + GATEWAY_PORT + '/v1',
    '        timeoutMs: 300000',
    '        streamIdleTimeoutMs: 300000',
    '        models:',
  ];
  for (const model of models) lines.push(...modelYaml(model));
  lines.push('      ' + MARK_END);
  return lines;
}

const MARK_BEGIN = '# >>> dsh-plugin-antigravity (managed block, delete to uninstall)';
const MARK_END = '# <<< dsh-plugin-antigravity';

function buildInsertBlock() {
  return [
    '',
    MARK_BEGIN,
    '# Local OpenAI-compatible gateway in front of the Antigravity models. Mounted by',
    '# absolute path on purpose: no package install and no pnpm run in the profile.',
    '- insert:',
    '    - id: antigravity-gateway',
    '      name: ' + JSON.stringify(PLUGIN_ENTRY),
    '      config:',
    '        host: 127.0.0.1',
    '        port: ' + GATEWAY_PORT,
    '        debugDir: ' + JSON.stringify(path.join(REPO, 'logs')),
    MARK_END,
  ];
}

/** Remove previously generated blocks so re-running the tool is idempotent. */
function stripGenerated(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('>>> dsh-plugin-antigravity')) {
      while (i < lines.length && !lines[i].includes('<<< dsh-plugin-antigravity')) i++;
      continue;
    }
    out.push(lines[i]);
  }
  return out;
}

/** Remove an unmarked provider block left by an earlier version of this tool. */
function stripLegacyProvider(lines, start, end) {
  const index = lines.findIndex((line, i) => i > start && i < end && /^\s{6}antigravity:\s*$/.test(line));
  if (index < 0) return lines;
  let stop = end;
  for (let i = index + 1; i < end; i++) {
    if (/^\s{6}\S/.test(lines[i])) { stop = i; break; }
  }
  let from = index;
  // Take the two managed-looking comment lines above it, if they are ours.
  while (from - 1 > start && /^\s{6}#/.test(lines[from - 1]) && /antigravity|Antigravity/.test(lines[from - 1])) from--;
  return [...lines.slice(0, from), ...lines.slice(stop)];
}

/** Remove an unmarked gateway insert row left by an earlier version of this tool. */
function stripLegacyInsert(lines) {
  const index = lines.findIndex((line) => /^\s{4}- id: antigravity-gateway\s*$/.test(line));
  if (index < 0) return lines;
  let from = index;
  while (from > 0 && !/^- insert:\s*$/.test(lines[from])) from--;
  if (!/^- insert:\s*$/.test(lines[from])) return lines;
  while (from > 0 && (lines[from - 1].trim() === '' || /^#/.test(lines[from - 1]))) from--;
  return lines.slice(0, from);
}

function buildPatch(original, models) {
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  let lines = stripLegacyInsert(stripGenerated(original.split(/\r?\n/)));

  const start = lines.findIndex((line) => /^- id: llm-pi-ai\s*$/.test(line));
  if (start < 0) throw new Error('llm-pi-ai entry not found in ' + PATCH_FILE);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^- (id|insert|disabled):/.test(lines[i])) { end = i; break; }
  }
  if (!lines.slice(start, end).some((line) => /^\s+providers:\s*$/.test(line))) {
    throw new Error('unexpected llm-pi-ai layout: no `providers:` inside the entry');
  }

  lines = stripLegacyProvider(lines, start, end);
  end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^- (id|insert|disabled):/.test(lines[i])) { end = i; break; }
  }

  // Drop trailing blank lines of the entry before appending the new provider.
  let insertAt = end;
  while (insertAt > start && lines[insertAt - 1].trim() === '') insertAt--;
  const text = [...lines.slice(0, insertAt), ...buildProviderLines(models), ...lines.slice(insertAt)]
    .join(eol)
    .replace(/\s*$/, '');
  return text + eol + buildInsertBlock().join(eol) + eol;
}

function validateWithDsh(patchText) {
  fs.rmSync(SCRATCH_HOME, { recursive: true, force: true });
  const checkDir = path.join(SCRATCH_HOME, 'profiles', 'check');
  fs.mkdirSync(checkDir, { recursive: true });
  fs.copyFileSync(path.join(PROFILE_DIR, 'package.json'), path.join(checkDir, 'package.json'));
  fs.writeFileSync(path.join(checkDir, 'cordis.patch.yml'), patchText, 'utf8');
  const cli = findDshCli();
  const env = { ...process.env, DSH_HOME: SCRATCH_HOME };
  // A .cmd shim with spaces in its path needs a shell and an explicitly quoted command line.
  const result = spawnSync('"' + cli + '" --profile check --dump-config', {
    encoding: 'utf8', env, timeout: 240_000, windowsHide: true, shell: true,
  });
  const output = String(result.stdout || '') + String(result.stderr || '') +
    (result.error ? '\nspawn error: ' + result.error.message : '');
  const ok = result.status === 0 && /id: antigravity-gateway/.test(output) && /antigravity:/.test(output);
  return { ok, status: result.status, output };
}

async function main() {
  const catalogue = await loadCatalogue();
  const models = (catalogue.models || []).filter((model) => !NOT_CHAT.test(model.id) && !EXCLUDED.has(model.id));

  const source = FROM || PATCH_FILE;
  const original = fs.readFileSync(source, 'utf8');
  const patchText = buildPatch(original, models);
  fs.mkdirSync(WORK, { recursive: true });
  const candidateFile = path.join(WORK, 'cordis.patch.candidate.yml');
  fs.writeFileSync(candidateFile, patchText, 'utf8');

  console.log('source profile patch: ' + source);
  console.log('models in route: ' + models.length + ' (' + models.map((model) => model.id).join(', ') + ')');
  console.log('candidate: ' + candidateFile + ' (' + patchText.length + ' bytes)');

  if (process.argv.includes('--no-validate')) {
    console.log('validation skipped (--no-validate)');
  } else {
    const validation = validateWithDsh(patchText);
    console.log('DSH compose check: ' + (validation.ok ? 'OK' : 'FAILED') + ' (exit ' + validation.status + ')');
    if (!validation.ok) {
      console.error(validation.output.split(/\r?\n/).slice(-25).join('\n'));
      process.exit(1);
    }
  }

  if (!APPLY) {
    console.log('dry run: nothing written. Re-run with --apply to install.');
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = PATCH_FILE + '.bak-' + stamp;
  fs.copyFileSync(PATCH_FILE, backup);
  fs.writeFileSync(PATCH_FILE, patchText, 'utf8');
  console.log('profile patch written (backup: ' + backup + ')');
  console.log('DSH recomposes the profile live; verify with: curl http://127.0.0.1:' + GATEWAY_PORT + '/health');
}

main().catch((error) => {
  console.error('FATAL: ' + (error && error.stack ? error.stack : error));
  process.exit(1);
});
