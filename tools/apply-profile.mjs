// language: JavaScript (ESM), file: tools/apply-profile.mjs, runtime: Node >= 20
// Installs the Antigravity native LLM adapter into a DSH profile.
//
// The plugin is a plain Cordis plugin mounted by absolute path — no package install and no
// pnpm run in the profile. It registers itself with the harness `llm` service, so there is
// no provider row in `llm-pi-ai` to maintain and no model list to regenerate:
//
//   - insert one `antigravity-llm` row into $DSH_HOME/profiles/<profile>/cordis.patch.yml;
//   - remove any block this tool previously managed (idempotent re-runs);
//   - validate the result with DSH's own patcher under a scratch DSH_HOME.
//
//   node tools/apply-profile.mjs                    # dry run, writes nothing
//   node tools/apply-profile.mjs --apply            # backup + write the profile patch
//   node tools/apply-profile.mjs --apply --pristine # start from the oldest local backup
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

const APPLY = process.argv.includes('--apply');
const PRISTINE = process.argv.includes('--pristine');
// --package mounts by package name instead of absolute path; it requires the plugin to be
// installed into the profile first (`dsh plugin --profile <p> add link:<repo>/plugin`) and is
// what makes DSH watch the linked sources for live reload.
const PACKAGE_MODE = process.argv.includes('--package');
const PACKAGE_NAME = 'dsh-plugin-antigravity';

const MARK_BEGIN = '# >>> dsh-plugin-antigravity (managed block, delete to uninstall)';
const MARK_END = '# <<< dsh-plugin-antigravity';
const PLUGIN_ENTRY = path.join(REPO, 'plugin', 'index.mjs').replace(/\\/g, '/');
const MEDIA_DIR = path.join(REPO, 'media').replace(/\\/g, '/');

const INSERT_BLOCK = [
  '',
  MARK_BEGIN,
  '# Native LLM adapter for the models of the installed Google Antigravity app.',
  PACKAGE_MODE
    ? '# Mounted by package name from the profile link: DSH reloads the linked sources on change.'
    : '# Mounted by absolute path on purpose: no package install and no pnpm run in the profile.',
  '- insert:',
  '    - id: antigravity-llm',
  '      name: ' + JSON.stringify(PACKAGE_MODE ? PACKAGE_NAME : PLUGIN_ENTRY),
  '      config:',
  '        enabled: true',
  '        debugDir: ' + JSON.stringify(path.join(REPO, 'logs').replace(/\\/g, '/')),
  '        features:',
  '          # Google Search grounding (unavailable on turns that pass tools — endpoint limitation).',
  '          googleSearch: false',
  '          # Generated images are written here and referenced from the answer as markdown.',
  '          imageOutput: true',
  '          imageGen: true',
  '          mediaOutputDir: ' + JSON.stringify(MEDIA_DIR),
  MARK_END,
].join('\n');

function findDshCli() {
  if (process.env.DSH_CLI) return process.env.DSH_CLI;
  const candidates = [
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
    '/usr/local/bin/dsh',
    '/opt/DeepSeek Harness/resources/runtime/cli/bin/dsh',
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || 'dsh';
}

/**
 * Newest .bak-* that predates this plugin — i.e. contains no Antigravity mention at all.
 * Using the *oldest* backup would silently revert unrelated profile edits, so the search
 * walks newest → oldest and stops at the first clean snapshot.
 */
function pristineSource() {
  const dir = path.dirname(PATCH_FILE);
  const base = path.basename(PATCH_FILE) + '.bak-';
  const candidates = fs.readdirSync(dir)
    .filter((name) => name.startsWith(base))
    .sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
  if (candidates.length === 0) throw new Error('no ' + base + '* backup found next to ' + PATCH_FILE);
  for (const name of candidates) {
    const file = path.join(dir, name);
    if (!/antigravity|dsh-plugin-antigravity/i.test(fs.readFileSync(file, 'utf8'))) return file;
  }
  throw new Error('every local backup mentions Antigravity; pass a clean patch via --from=');
}

/** Remove blocks this tool generated earlier. */
function stripManaged(text, eol) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('>>> dsh-plugin-antigravity')) {
      while (i < lines.length && !lines[i].includes('<<< dsh-plugin-antigravity')) i++;
      continue;
    }
    out.push(lines[i]);
  }
  return out.join(eol);
}

function validateWithDsh(patchText) {
  fs.rmSync(SCRATCH_HOME, { recursive: true, force: true });
  const checkDir = path.join(SCRATCH_HOME, 'profiles', 'check');
  fs.mkdirSync(checkDir, { recursive: true });
  fs.copyFileSync(path.join(PROFILE_DIR, 'package.json'), path.join(checkDir, 'package.json'));
  fs.writeFileSync(path.join(checkDir, 'cordis.patch.yml'), patchText, 'utf8');
  const cli = findDshCli();
  const env = { ...process.env, DSH_HOME: SCRATCH_HOME };
  const result = spawnSync('"' + cli + '" --profile check --dump-config', {
    encoding: 'utf8', env, timeout: 240_000, windowsHide: true, shell: true,
  });
  const output = String(result.stdout || '') + String(result.stderr || '') +
    (result.error ? '\nspawn error: ' + result.error.message : '');
  const mountOk = PACKAGE_MODE ? /name: dsh-plugin-antigravity/.test(output) : /plugin\/index\.mjs/.test(output);
  const ok = result.status === 0 && /id: antigravity-llm/.test(output) && mountOk;
  return { ok, status: result.status, output };
}

function main() {
  const sourceFile = PRISTINE ? pristineSource() : PATCH_FILE;
  const original = fs.readFileSync(sourceFile, 'utf8');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const candidate = stripManaged(original, eol).replace(/\s*$/, '') + eol + INSERT_BLOCK + eol;

  fs.mkdirSync(WORK, { recursive: true });
  const candidateFile = path.join(WORK, 'cordis.patch.candidate.yml');
  fs.writeFileSync(candidateFile, candidate, 'utf8');

  console.log('source:    ' + sourceFile);
  console.log('candidate: ' + candidateFile + ' (' + candidate.length + ' bytes)');

  const validation = validateWithDsh(candidate);
  console.log('DSH compose check: ' + (validation.ok ? 'OK' : 'FAILED') + ' (exit ' + validation.status + ')');
  if (!validation.ok) {
    console.error(validation.output.split(/\r?\n/).slice(-25).join('\n'));
    process.exit(1);
  }

  if (!APPLY) {
    console.log('dry run: nothing written. Re-run with --apply to install.');
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = PATCH_FILE + '.bak-' + stamp;
  fs.copyFileSync(PATCH_FILE, backup);
  fs.writeFileSync(PATCH_FILE, candidate, 'utf8');
  console.log('profile patch written (backup: ' + backup + ')');
  console.log('The adapter registers on the next profile recomposition (live) or restart.');
}

try {
  main();
} catch (error) {
  console.error('FATAL: ' + (error && error.stack ? error.stack : error));
  process.exit(1);
}
