// language: JavaScript (browser module), file: client.js, runtime: DSH Web page
// Client half of the plugin: one Settings section that shows the Antigravity account,
// its per-model limits, the live model catalogue and the effective plugin configuration,
// with a refresh action and a one-click imageGen smoke test.
//
// Loaded by the harness web plugin table (`dsh.client` in package.json) through
// window.__ModuleLoader__; React comes from the browser module table.
window.__ModuleLoader__.load({
  id: 'dsh-plugin-antigravity',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const COLOR = {
      text: 'var(--dsw-alias-label-primary)',
      secondary: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      surface: 'var(--dsw-alias-bg-layer-1)',
      surfaceNested: 'var(--dsw-alias-bg-layer-2)',
      brand: 'var(--dsw-alias-brand-primary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
    };

    const S = {
      root: { display: 'flex', flexDirection: 'column', gap: '20px', padding: '4px 2px 32px', maxWidth: '860px' },
      header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px' },
      title: { margin: 0, fontSize: '18px', fontWeight: 600, color: COLOR.text },
      subtitle: { margin: '4px 0 0', fontSize: '12px', color: COLOR.secondary, lineHeight: 1.5 },
      card: { border: '1px solid ' + COLOR.border, borderRadius: '10px', background: COLOR.surface, padding: '14px 16px' },
      cardTitle: { margin: '0 0 10px', fontSize: '13px', fontWeight: 600, color: COLOR.text },
      row: { display: 'flex', alignItems: 'center', gap: '10px' },
      label: { fontSize: '12px', color: COLOR.secondary },
      value: { fontSize: '13px', color: COLOR.text },
      button: {
        border: '1px solid ' + COLOR.border, borderRadius: '8px', background: COLOR.surfaceNested,
        color: COLOR.text, fontSize: '12px', padding: '6px 12px', cursor: 'pointer',
      },
      buttonPrimary: {
        border: '1px solid ' + COLOR.brand, borderRadius: '8px', background: COLOR.brand,
        color: '#fff', fontSize: '12px', padding: '6px 12px', cursor: 'pointer',
      },
      barTrack: { height: '6px', borderRadius: '999px', background: COLOR.surfaceNested, overflow: 'hidden', flex: 1, minWidth: '80px' },
      barFill: (fraction, color) => ({ height: '100%', width: Math.max(0, Math.min(1, fraction)) * 100 + '%', background: color, borderRadius: '999px' }),
      quotaRow: { display: 'grid', gridTemplateColumns: 'minmax(160px, 1.2fr) minmax(120px, 2fr) 72px minmax(120px, 1.4fr)', gap: '10px', alignItems: 'center', padding: '6px 0', borderTop: '1px solid ' + COLOR.border },
      modelRow: { display: 'grid', gridTemplateColumns: 'minmax(180px, 1.6fr) 96px 96px 96px', gap: '8px', alignItems: 'center', padding: '5px 0', borderTop: '1px solid ' + COLOR.border, fontSize: '12px' },
      badge: (color) => ({ display: 'inline-block', border: '1px solid ' + color, color, borderRadius: '999px', fontSize: '10px', padding: '1px 7px', marginLeft: '6px' }),
      chip: { display: 'inline-block', border: '1px solid ' + COLOR.border, borderRadius: '999px', fontSize: '11px', padding: '2px 9px', marginRight: '6px', marginBottom: '6px', color: COLOR.text },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '11px', color: COLOR.secondary, wordBreak: 'break-all' },
      error: { border: '1px solid ' + COLOR.error, color: COLOR.error, borderRadius: '8px', padding: '8px 12px', fontSize: '12px' },
      muted: { fontSize: '11px', color: COLOR.secondary, lineHeight: 1.5 },
      input: {
        border: '1px solid ' + COLOR.border, borderRadius: '8px', background: COLOR.bg || 'transparent',
        color: COLOR.text, fontSize: '12px', padding: '6px 10px', minWidth: '0', flex: 1,
      },
      preview: { marginTop: '10px', borderRadius: '8px', border: '1px solid ' + COLOR.border, maxWidth: '320px', display: 'block' },
    };

    function quotaColor(fraction) {
      if (fraction === undefined) return COLOR.idle;
      if (fraction <= 0.1) return COLOR.error;
      if (fraction <= 0.35) return COLOR.warn;
      return COLOR.ok;
    }

    function formatPercent(fraction) {
      if (fraction === undefined) return '—';
      return Math.round(fraction * 100) + '%';
    }

    function formatTime(iso) {
      if (!iso) return '—';
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return iso;
      return date.toLocaleString();
    }

    function Card(props) {
      return h('section', { style: S.card }, props.title ? h('h3', { style: S.cardTitle }, props.title) : null, props.children);
    }

    function useStatus() {
      const [state, setState] = React.useState({ phase: 'loading', data: null, error: null, busy: false, cached: false });
      const load = React.useCallback(async (refresh) => {
        setState((current) => ({ ...current, busy: true, error: null }));
        try {
          const response = await fetch('/antigravity/status' + (refresh ? '?refresh=1' : ''), { cache: 'no-store' });
          const json = await response.json();
          if (!json || json.ok !== true) throw new Error((json && json.error) || 'HTTP ' + response.status);
          setState({ phase: 'ready', data: json, error: null, busy: false, cached: Boolean(json.cached) });
        } catch (error) {
          setState((current) => ({ phase: current.data ? 'ready' : 'error', data: current.data, error: String(error && error.message ? error.message : error), busy: false, cached: false }));
        }
      }, []);
      React.useEffect(() => {
        let alive = true;
        (async () => { if (alive) await load(false); })();
        return () => { alive = false; };
      }, [load]);
      return { ...state, reload: load };
    }

    function QuotaSection(props) {
      const quotas = props.quotas || [];
      if (quotas.length === 0) {
        return h(Card, { title: 'Лимиты моделей (Antigravity quota)' },
          h('div', { style: S.muted }, props.error
            ? 'Не удалось получить квоты: ' + props.error
            : 'Аккаунт не вернул квоты (у бесплатных планов они бывают скрыты). Показатели появятся после первого запроса.'));
      }
      const sorted = [...quotas].sort((a, b) => String(a.modelId).localeCompare(String(b.modelId)));
      return h(Card, { title: 'Лимиты моделей (Antigravity quota)' },
        h('div', { style: { ...S.label, display: 'grid', gridTemplateColumns: S.quotaRow.gridTemplateColumns, gap: '10px', paddingBottom: '4px' } },
          h('span', null, 'Модель'), h('span', null, 'Остаток'), h('span', null, 'Доля'), h('span', null, 'Сброс')),
        sorted.map((quota) => h('div', { key: quota.modelId, style: S.quotaRow },
          h('span', { style: { ...S.value, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, quota.modelId),
          h('div', { style: S.barTrack }, h('div', { style: S.barFill(quota.remainingFraction, quotaColor(quota.remainingFraction)) })),
          h('span', { style: { ...S.value, color: quotaColor(quota.remainingFraction) } }, formatPercent(quota.remainingFraction)),
          h('span', { style: S.label }, formatTime(quota.resetTime)))));
    }

    function ModelsSection(props) {
      const models = props.models || [];
      if (models.length === 0) return h(Card, { title: 'Каталог моделей' }, h('div', { style: S.muted }, props.error ? 'Ошибка: ' + props.error : 'Каталог пуст.'));
      const chat = models.filter((model) => model.kind === 'chat');
      const image = models.filter((model) => model.kind === 'image');
      const row = (model) => h('div', { key: model.id, style: S.modelRow },
        h('span', { style: { ...S.value, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          model.name,
          model.thinking ? h('span', { style: S.badge(COLOR.brand) }, 'thinking') : null,
          model.recommended ? h('span', { style: S.badge(COLOR.ok) }, 'recommended') : null),
        h('span', { style: S.label }, model.contextWindow ? Math.round(model.contextWindow / 1024) + 'k ctx' : '—'),
        h('span', { style: S.label }, model.maxTokens ? Math.round(model.maxTokens / 1024) + 'k out' : '—'),
        h('span', { style: S.label }, (model.input || []).join(' + ')));
      return h(Card, { title: 'Каталог моделей (' + chat.length + ' чат' + (image.length ? ', ' + image.length + ' изображения' : '') + ')' },
        chat.map(row),
        image.length ? h('div', { style: { marginTop: '10px' } }, h('div', { style: S.label }, 'ImageGen'), image.map(row)) : null);
    }

    function FeaturesSection(props) {
      const features = props.features || {};
      const keys = Object.keys(features).sort();
      return h(Card, { title: 'Настройки плагина' },
        keys.length === 0
          ? h('div', { style: S.muted }, 'Особые возможности не включены — работают значения по умолчанию.')
          : h('div', null, keys.map((key) => h('span', { key, style: S.chip }, key + ': ' + JSON.stringify(features[key])))),
        h('div', { style: { ...S.muted, marginTop: '8px' } },
          'Эти флаги правятся в $DSH_HOME/profiles/<profile>/cordis.patch.yml в блоке antigravity-llm (features.*); ',
          'например: googleSearch: true, imageGen: false, mediaOutputDir. После правки перезапуск не нужен, если меняется только конфиг.'));
    }

    function TestImageSection() {
      const [prompt, setPrompt] = React.useState('a small red circle on a plain white background');
      const [busy, setBusy] = React.useState(false);
      const [result, setResult] = React.useState(null);
      const [error, setError] = React.useState(null);
      const run = React.useCallback(async () => {
        setBusy(true); setError(null); setResult(null);
        try {
          const response = await fetch('/antigravity/test-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt }),
          });
          const json = await response.json();
          if (!json.ok) throw new Error((json.code ? json.code + ': ' : '') + (json.error || 'image generation failed'));
          setResult(json);
        } catch (failure) {
          setError(String(failure && failure.message ? failure.message : failure));
        } finally {
          setBusy(false);
        }
      }, [prompt]);
      return h(Card, { title: 'Проверка imageGen' },
        h('div', { style: { ...S.row, marginBottom: '8px' } },
          h('input', {
            style: S.input, value: prompt, placeholder: 'что нарисовать',
            onChange: (event) => setPrompt(event.target.value),
          }),
          h('button', { style: S.buttonPrimary, disabled: busy, onClick: run, type: 'button' },
            busy ? 'Генерация…' : 'Сгенерировать')),
        error ? h('div', { style: S.error }, error) : null,
        result ? h('div', null,
          result.images.map((image) => h('div', { key: image.name },
            h('img', { src: '/antigravity/media/' + encodeURIComponent(image.name), alt: image.name, style: S.preview }),
            h('div', { style: S.mono }, image.path + ' · ' + image.bytes + ' B'))),
          result.text ? h('div', { style: S.muted }, result.text) : null) : null,
        h('div', { style: { ...S.muted, marginTop: '8px' } },
          'Генерирует встроенная image-модель Antigravity; расходует квоту аккаунта.'));
    }

    function AccountSection(props) {
      const account = props.account || {};
      const rows = [
        ['Тариф', account.tierName || account.tier || '—'],
        ['Проект', account.project || '—'],
        ['Платный тариф', account.paidTier || '—'],
        ['API', props.upstream || '—'],
        ['Креды', props.credentialTarget || '—'],
        ['User-Agent', props.userAgent || '—'],
      ];
      return h(Card, { title: 'Аккаунт Antigravity' },
        rows.map(([label, value]) => h('div', { key: label, style: { ...S.row, justifyContent: 'space-between', padding: '3px 0' } },
          h('span', { style: S.label }, label),
          h('span', { style: { ...S.value, textAlign: 'right' } }, value))),
        props.accountsError ? h('div', { style: { ...S.muted, marginTop: '6px' } }, 'loadCodeAssist: ' + props.accountsError) : null);
    }

    function AntigravitySettings() {
      const status = useStatus();
      const data = status.data || {};
      return h('div', { style: S.root },
        h('div', { style: S.header },
          h('div', null,
            h('h2', { style: S.title }, 'Antigravity'),
            h('p', { style: S.subtitle },
              'Модели Google Antigravity в этом харнессе: лимиты аккаунта, каталог и встроенный imageGen. ',
              data.at ? 'Данные на ' + formatTime(data.at) + (status.cached ? ' (кэш)' : '') : '')),
          h('button', { type: 'button', style: S.button, disabled: status.busy, onClick: () => status.reload(true) },
            status.busy ? 'Обновление…' : 'Обновить')),
        status.error ? h('div', { style: S.error }, 'API плагина недоступен: ' + status.error) : null,
        status.phase === 'loading' ? h('div', { style: S.muted }, 'Загрузка…') : null,
        status.phase !== 'loading' ? h(AccountSection, {
          account: data.account, accountsError: data.accountsError,
          upstream: data.upstream, credentialTarget: data.credentialTarget, userAgent: data.userAgent,
        }) : null,
        status.phase !== 'loading' ? h(QuotaSection, { quotas: data.quotas, error: data.quotasError }) : null,
        status.phase !== 'loading' ? h(ModelsSection, { models: data.models, error: data.modelsError }) : null,
        status.phase !== 'loading' ? h(FeaturesSection, { features: data.features }) : null,
        h(TestImageSection));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'antigravity',
          order: 30,
          label: 'Antigravity',
        }, AntigravitySettings));
      },
    };
  },
});
