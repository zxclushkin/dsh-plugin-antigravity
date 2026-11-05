// Account status report shown by the `Antigravity: Show account status` command.
//
// Rendering is a pure function so the shape of the report can be unit-tested without an
// editor; the command layer only gathers facts and opens a markdown document.
export interface AccountFacts {
  project?: string;
  tier?: string;
  tierName?: string;
  paidTier?: string;
  error?: string;
}

export interface StatusFacts {
  account: AccountFacts;
  quota: Record<string, number | undefined>;
  models: { chat: number; image: number; ids: string[] };
  credential: { cached: boolean; expiresAt: string | null; clientCandidates: number };
  throttle: { maxConcurrent: number; minIntervalMs: number; cooldownUntil?: string | null };
}

function percent(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return Math.round(value * 100) + '%';
}

export function renderStatus(facts: StatusFacts, now = new Date()): string {
  const { account, quota, models, credential, throttle } = facts;
  const lines: string[] = [];
  lines.push('# Antigravity');
  lines.push('');
  lines.push('_Generated ' + now.toISOString() + '_');
  lines.push('');

  lines.push('## Account');
  lines.push('');
  if (account.error) {
    lines.push('Could not read the account: `' + account.error + '`');
  } else {
    lines.push('| Field | Value |');
    lines.push('| --- | --- |');
    lines.push('| Plan | ' + (account.paidTier || account.tierName || account.tier || '—') + ' |');
    lines.push('| Project | ' + (account.project || '—') + ' |');
  }
  lines.push('');

  lines.push('## Credentials');
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('| --- | --- |');
  lines.push('| Access token cached | ' + (credential.cached ? 'yes' : 'no') + ' |');
  lines.push('| Expires | ' + (credential.expiresAt || '—') + ' |');
  lines.push('| OAuth client candidates | ' + credential.clientCandidates + ' |');
  lines.push('');

  lines.push('## Request shaping');
  lines.push('');
  lines.push('- Concurrent requests: ' + throttle.maxConcurrent);
  lines.push('- Minimum spacing: ' + throttle.minIntervalMs + ' ms');
  lines.push('- Cooldown: ' + (throttle.cooldownUntil || 'none'));
  lines.push('');

  lines.push('## Models');
  lines.push('');
  lines.push(models.chat + ' chat, ' + models.image + ' image.');
  lines.push('');
  const quotaIds = Object.keys(quota);
  if (quotaIds.length > 0) {
    lines.push('| Model | Remaining quota |');
    lines.push('| --- | --- |');
    for (const id of quotaIds.sort()) lines.push('| ' + id + ' | ' + percent(quota[id]) + ' |');
    lines.push('');
  }
  if (models.ids.length > 0) {
    lines.push('<details><summary>Model ids</summary>');
    lines.push('');
    for (const id of models.ids) lines.push('- `' + id + '`');
    lines.push('');
    lines.push('</details>');
  }
  return lines.join('\n');
}
