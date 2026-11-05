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
      // Native <select> popups are painted by the browser, not the page: without an explicit
      // color/background the options inherit the light-on-dark page color onto a white popup and
      // become unreadable. Theme both the control and its options from the same tokens.
      select: {
        border: '1px solid ' + COLOR.border, borderRadius: '8px', background: COLOR.surfaceNested,
        color: COLOR.text, fontSize: '12px', padding: '6px 10px', minWidth: '0',
      },
      option: { background: COLOR.surfaceNested, color: COLOR.text },
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

    // ---- localization -------------------------------------------------------
    // Every user-visible string of this settings page lives here. The dictionaries
    // are registered through the DSH client locale service under one namespace, so a
    // locale switch re-renders the slot and `t(...)` resolves the new language at
    // call time without re-registering anything. English is the baseline dictionary:
    // it backs `fallbackT` in compositions without a locale service and defines the
    // key set the other dictionaries must match. Technical values (model ids, tool
    // names, paths, numbers, HTTP statuses) stay untranslated on purpose.
    const NS = 'antigravity';
    const LOCALE = {
      en: {
        'page.subtitle': 'Google Antigravity models in this harness: account limits, the catalogue, tools and the built-in imageGen.',
        'page.dataAt': 'Data as of {time}',
        'page.cached': '(cached)',
        'page.apiUnavailable': 'Plugin API is unavailable: {error}',
        'common.refresh': 'Refresh',
        'common.refreshing': 'Refreshing…',
        'common.loading': 'Loading…',
        'common.save': 'Save',
        'common.saving': 'Saving…',
        'common.default': 'default',
        'common.none': 'none',
        'account.title': 'Antigravity account',
        'account.tier': 'Tier',
        'account.project': 'Project',
        'account.paidTier': 'Paid tier',
        'account.credentials': 'Credentials',
        'quota.title': 'Model limits (Antigravity quota)',
        'quota.model': 'Model',
        'quota.remaining': 'Remaining',
        'quota.fraction': 'Share',
        'quota.reset': 'Reset',
        'quota.empty': 'The account returned no quotas (free plans sometimes hide them). Figures appear after the first request.',
        'quota.error': 'Could not load quotas: {error}',
        'models.title': 'Model catalogue',
        'models.titleCounts': 'Model catalogue: {chat} chat models',
        'models.titleCountsImage': 'Model catalogue: {chat} chat models, {image} image models',
        'models.empty': 'The catalogue is empty.',
        'models.error': 'Error: {error}',
        'models.badgeThinking': 'thinking',
        'models.badgeRecommended': 'recommended',
        'features.title': 'Plugin settings',
        'features.googleSearchTool': 'google_search tool: the agent can search Google with sources',
        'features.googleSearch': 'Grounding on direct requests without tools (the endpoint allows it)',
        'features.imageGen': 'Built-in imageGen: the image_generate tool for any model',
        'features.durableImages': 'Durable images: keep generated files in the harness attachment store',
        'features.imageOutput': 'Image model in the model list',
        'features.includeThoughts': 'includeThoughts (the endpoint ignores it)',
        'features.thinking': 'Thinking',
        'features.aspect': 'Aspect',
        'features.saved': 'Saved: {features}',
        'features.saveFailed': 'failed to save',
        'features.noteSave': 'The flags are written to the plugin config (the antigravity-llm block in cordis.patch.yml) through the DSH config editor and apply without a restart.',
        'features.notePaths': 'Paths (mediaOutputDir, debugDir), models and credentials are still set in the patch file.',
        'runtime.title': 'Service',
        'runtime.version': 'Plugin version',
        'runtime.tools': 'Tools',
        'runtime.maxConcurrent': 'Concurrent requests',
        'runtime.minInterval': 'Interval between requests',
        'runtime.intervalValue': '{value} ms',
        'runtime.cooldown': 'Pause after 429',
        'runtime.cooldownValue': '{value} s',
        'runtime.active': 'In progress',
        'runtime.queueValue': '{active}, {queued} queued',
        'runtime.cooldownUntil': 'Paused after the rate limit until {time}',
        'runtime.lastError': 'Last error ({time}, {code}): {message}',
        'search.title': 'google_search test',
        'search.placeholder': 'what to find',
        'search.run': 'Search',
        'search.running': 'Searching…',
        'search.failed': 'search failed',
        'search.queries': 'queries: {list}',
        'search.note': 'One grounded request through googleSearch; it consumes the search model quota.',
        'search.defaultQuery': 'Who won the last Formula 1 world championship?',
        'image.title': 'imageGen test',
        'image.placeholder': 'what to draw',
        'image.run': 'Generate',
        'image.generating': 'Generating…',
        'image.failed': 'image generation failed',
        'image.note': 'Generated by the built-in Antigravity image model; it consumes the account quota.',
        'image.defaultPrompt': 'a small red circle on a plain white background',
        'thinking.low': 'low',
        'thinking.medium': 'medium',
        'thinking.high': 'high',
      },
      zh: {
        'page.subtitle': '本 harness 中的 Google Antigravity 模型：账户限额、模型目录、工具与内置 imageGen。',
        'page.dataAt': '数据截至 {time}',
        'page.cached': '（缓存）',
        'page.apiUnavailable': '插件 API 不可用：{error}',
        'common.refresh': '刷新',
        'common.refreshing': '刷新中…',
        'common.loading': '加载中…',
        'common.save': '保存',
        'common.saving': '保存中…',
        'common.default': '默认',
        'common.none': '无',
        'account.title': 'Antigravity 账户',
        'account.tier': '套餐',
        'account.project': '项目',
        'account.paidTier': '付费套餐',
        'account.credentials': '凭据',
        'quota.title': '模型限额（Antigravity quota）',
        'quota.model': '模型',
        'quota.remaining': '剩余',
        'quota.fraction': '占比',
        'quota.reset': '重置',
        'quota.empty': '账户未返回限额（免费套餐有时会隐藏）。首次请求后才会显示数值。',
        'quota.error': '无法获取限额：{error}',
        'models.title': '模型目录',
        'models.titleCounts': '模型目录：对话模型 {chat} 个',
        'models.titleCountsImage': '模型目录：对话模型 {chat} 个，图像模型 {image} 个',
        'models.empty': '目录为空。',
        'models.error': '错误：{error}',
        'models.badgeThinking': '思考',
        'models.badgeRecommended': '推荐',
        'features.title': '插件设置',
        'features.googleSearchTool': 'google_search 工具：智能体可以带来源地搜索 Google',
        'features.googleSearch': '在无工具的直连请求上启用 grounding（端点允许这样做）',
        'features.imageGen': '内置 imageGen：任何模型都可使用 image_generate 工具',
        'features.durableImages': '持久图片：将生成的文件保存在 harness 附件库中',
        'features.imageOutput': '在模型列表中显示图像模型',
        'features.includeThoughts': 'includeThoughts（端点会忽略它）',
        'features.thinking': '思考级别',
        'features.aspect': '宽高比',
        'features.saved': '已保存：{features}',
        'features.saveFailed': '保存失败',
        'features.noteSave': '这些开关通过 DSH 的 config editor 写入插件配置（cordis.patch.yml 中的 antigravity-llm 块），无需重启即可生效。',
        'features.notePaths': '路径（mediaOutputDir、debugDir）、模型和凭据仍在 patch 文件中设置。',
        'runtime.title': '运行信息',
        'runtime.version': '插件版本',
        'runtime.tools': '工具',
        'runtime.maxConcurrent': '并发请求数',
        'runtime.minInterval': '请求间隔',
        'runtime.intervalValue': '{value} 毫秒',
        'runtime.cooldown': '429 后暂停',
        'runtime.cooldownValue': '{value} 秒',
        'runtime.active': '进行中',
        'runtime.queueValue': '{active} 个进行中，{queued} 个排队',
        'runtime.cooldownUntil': '触发限流，暂停至 {time}',
        'runtime.lastError': '最近错误（{time}，{code}）：{message}',
        'search.title': 'google_search 测试',
        'search.placeholder': '要查找什么',
        'search.run': '查找',
        'search.running': '搜索中…',
        'search.failed': '搜索失败',
        'search.queries': '查询：{list}',
        'search.note': '通过 googleSearch 发起一次 grounded 请求；会消耗搜索模型的限额。',
        'search.defaultQuery': '上一届一级方程式世界锦标赛冠军是谁？',
        'image.title': 'imageGen 测试',
        'image.placeholder': '要画什么',
        'image.run': '生成',
        'image.generating': '生成中…',
        'image.failed': '图像生成失败',
        'image.note': '由内置的 Antigravity 图像模型生成；会消耗账户限额。',
        'image.defaultPrompt': '纯白背景上的一个小红圆',
        'thinking.low': '低',
        'thinking.medium': '中',
        'thinking.high': '高',
      },
      ru: {
        'page.subtitle': 'Модели Google Antigravity в этом харнессе: лимиты аккаунта, каталог, инструменты и встроенный imageGen.',
        'page.dataAt': 'Данные на {time}',
        'page.cached': '(кэш)',
        'page.apiUnavailable': 'API плагина недоступен: {error}',
        'common.refresh': 'Обновить',
        'common.refreshing': 'Обновление…',
        'common.loading': 'Загрузка…',
        'common.save': 'Сохранить',
        'common.saving': 'Сохранение…',
        'common.default': 'по умолчанию',
        'common.none': 'нет',
        'account.title': 'Аккаунт Antigravity',
        'account.tier': 'Тариф',
        'account.project': 'Проект',
        'account.paidTier': 'Платный тариф',
        'account.credentials': 'Креды',
        'quota.title': 'Лимиты моделей (Antigravity quota)',
        'quota.model': 'Модель',
        'quota.remaining': 'Остаток',
        'quota.fraction': 'Доля',
        'quota.reset': 'Сброс',
        'quota.empty': 'Аккаунт не вернул квоты (у бесплатных планов они бывают скрыты). Показатели появятся после первого запроса.',
        'quota.error': 'Не удалось получить квоты: {error}',
        'models.title': 'Каталог моделей',
        'models.titleCounts': 'Каталог моделей: чат — {chat}',
        'models.titleCountsImage': 'Каталог моделей: чат — {chat}, изображения — {image}',
        'models.empty': 'Каталог пуст.',
        'models.error': 'Ошибка: {error}',
        'models.badgeThinking': 'размышления',
        'models.badgeRecommended': 'рекомендуемая',
        'features.title': 'Настройки плагина',
        'features.googleSearchTool': 'Инструмент google_search: агент может искать в Google с источниками',
        'features.googleSearch': 'Grounding на прямых запросах без инструментов (эндпоинт так разрешает)',
        'features.imageGen': 'Встроенный imageGen: инструмент image_generate для любой модели',
        'features.durableImages': 'Durable-картинки: хранить сгенерированные файлы в хранилище вложений харнесса',
        'features.imageOutput': 'Image-модель в списке моделей',
        'features.includeThoughts': 'includeThoughts (эндпоинт его игнорирует)',
        'features.thinking': 'Размышления',
        'features.aspect': 'Пропорции',
        'features.saved': 'Сохранено: {features}',
        'features.saveFailed': 'не удалось сохранить',
        'features.noteSave': 'Флаги сохраняются в конфиг плагина (блок antigravity-llm в cordis.patch.yml) через config editor DSH и применяются без перезапуска.',
        'features.notePaths': 'Пути (mediaOutputDir, debugDir), модели и креды по-прежнему задаются в patch-файле.',
        'runtime.title': 'Служебное',
        'runtime.version': 'Версия плагина',
        'runtime.tools': 'Инструменты',
        'runtime.maxConcurrent': 'Параллельных запросов',
        'runtime.minInterval': 'Интервал между запросами',
        'runtime.intervalValue': '{value} мс',
        'runtime.cooldown': 'Пауза после 429',
        'runtime.cooldownValue': '{value} с',
        'runtime.active': 'Сейчас в работе',
        'runtime.queueValue': '{active}, в очереди {queued}',
        'runtime.cooldownUntil': 'Пауза после rate limit до {time}',
        'runtime.lastError': 'Последняя ошибка ({time}, {code}): {message}',
        'search.title': 'Проверка google_search',
        'search.placeholder': 'что найти',
        'search.run': 'Найти',
        'search.running': 'Поиск…',
        'search.failed': 'поиск не удался',
        'search.queries': 'queries: {list}',
        'search.note': 'Один grounded-запрос через googleSearch; расходует квоту модели поиска.',
        'search.defaultQuery': 'Кто выиграл последний чемпионат мира Формулы-1?',
        'image.title': 'Проверка imageGen',
        'image.placeholder': 'что нарисовать',
        'image.run': 'Сгенерировать',
        'image.generating': 'Генерация…',
        'image.failed': 'не удалось сгенерировать изображение',
        'image.note': 'Генерирует встроенная image-модель Antigravity; расходует квоту аккаунта.',
        'image.defaultPrompt': 'маленький красный круг на однотонном белом фоне',
        'thinking.low': 'низкий',
        'thinking.medium': 'средний',
        'thinking.high': 'высокий',
      },
    };

    // Mirrors the locale service's `{name}` interpolation for the fallback path.
    function interpolate(template, params) {
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
    }

    function fallbackT(key, params) {
      return interpolate(LOCALE.en[key] ?? key, params);
    }

    // Bound by apply() when the locale service is composed; components read it at
    // render time, so the binding stays stable across locale switches.
    let t = fallbackT;

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
        return h(Card, { title: t('quota.title') },
          h('div', { style: S.muted }, props.error
            ? t('quota.error', { error: props.error })
            : t('quota.empty')));
      }
      const sorted = [...quotas].sort((a, b) => String(a.modelId).localeCompare(String(b.modelId)));
      return h(Card, { title: t('quota.title') },
        h('div', { style: { ...S.label, display: 'grid', gridTemplateColumns: S.quotaRow.gridTemplateColumns, gap: '10px', paddingBottom: '4px' } },
          h('span', null, t('quota.model')), h('span', null, t('quota.remaining')), h('span', null, t('quota.fraction')), h('span', null, t('quota.reset'))),
        sorted.map((quota) => h('div', { key: quota.modelId, style: S.quotaRow },
          h('span', { style: { ...S.value, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, quota.modelId),
          h('div', { style: S.barTrack }, h('div', { style: S.barFill(quota.remainingFraction, quotaColor(quota.remainingFraction)) })),
          h('span', { style: { ...S.value, color: quotaColor(quota.remainingFraction) } }, formatPercent(quota.remainingFraction)),
          h('span', { style: S.label }, formatTime(quota.resetTime)))));
    }

    function ModelsSection(props) {
      const models = props.models || [];
      if (models.length === 0) return h(Card, { title: t('models.title') }, h('div', { style: S.muted }, props.error ? t('models.error', { error: props.error }) : t('models.empty')));
      const chat = models.filter((model) => model.kind === 'chat');
      const image = models.filter((model) => model.kind === 'image');
      const row = (model) => h('div', { key: model.id, style: S.modelRow },
        h('span', { style: { ...S.value, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          model.name,
          model.thinking ? h('span', { style: S.badge(COLOR.brand) }, t('models.badgeThinking')) : null,
          model.recommended ? h('span', { style: S.badge(COLOR.ok) }, t('models.badgeRecommended')) : null),
        h('span', { style: S.label }, model.contextWindow ? Math.round(model.contextWindow / 1024) + 'k ctx' : '—'),
        h('span', { style: S.label }, model.maxTokens ? Math.round(model.maxTokens / 1024) + 'k out' : '—'),
        h('span', { style: S.label }, (model.input || []).join(' + ')));
      const title = image.length
        ? t('models.titleCountsImage', { chat: chat.length, image: image.length })
        : t('models.titleCounts', { chat: chat.length });
      return h(Card, { title },
        chat.map(row),
        image.length ? h('div', { style: { marginTop: '10px' } }, h('div', { style: S.label }, 'ImageGen'), image.map(row)) : null);
    }

function Toggle(props) {
      return h('label', {
        style: { display: 'flex', alignItems: 'flex-start', gap: '8px', padding: '4px 0', fontSize: '12px', color: COLOR.text, cursor: 'pointer' },
      },
        h('input', { type: 'checkbox', checked: Boolean(props.checked), onChange: (event) => props.onChange(event.target.checked) }),
        h('span', null, props.label));
    }

    const THINKING_LEVELS = ['', 'low', 'medium', 'high'];
    const ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4'];

    function FeaturesSection(props) {
      const features = props.features || {};
      const [draft, setDraft] = React.useState(Object.assign({}, features));
      const [busy, setBusy] = React.useState(false);
      const [message, setMessage] = React.useState(null);
      const [error, setError] = React.useState(null);

      React.useEffect(() => { setDraft(Object.assign({}, features)); }, [JSON.stringify(features)]);

      const toggles = [
        ['googleSearchTool', 'features.googleSearchTool'],
        ['googleSearch', 'features.googleSearch'],
        ['imageGen', 'features.imageGen'],
        ['durableImages', 'features.durableImages'],
        ['imageOutput', 'features.imageOutput'],
        ['includeThoughts', 'features.includeThoughts'],
      ];

      const save = React.useCallback(async () => {
        setBusy(true); setError(null); setMessage(null);
        try {
          const payload = { features: {} };
          for (const entry of toggles) payload.features[entry[0]] = Boolean(draft[entry[0]]);
          if (draft.defaultThinkingLevel) payload.features.defaultThinkingLevel = draft.defaultThinkingLevel;
          if (draft.imageAspectRatio) payload.features.imageAspectRatio = draft.imageAspectRatio;
          const response = await fetch('/antigravity/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const json = await response.json();
          if (!json.ok) throw new Error((json.error || t('features.saveFailed')));
          setMessage(JSON.stringify(json.features));
          if (props.onSaved) props.onSaved();
        } catch (failure) {
          setError(String(failure && failure.message ? failure.message : failure));
        } finally {
          setBusy(false);
        }
      }, [JSON.stringify(draft)]);

      return h(Card, { title: t('features.title') },
        toggles.map((entry) => h(Toggle, {
          key: entry[0],
          label: t(entry[1]),
          checked: Boolean(draft[entry[0]]),
          onChange: (value) => setDraft(Object.assign({}, draft, { [entry[0]]: value })),
        })),
        h('div', { style: { ...S.row, marginTop: '10px', gap: '16px', flexWrap: 'wrap' } },
          h('label', { style: { ...S.label, display: 'flex', alignItems: 'center', gap: '6px' } }, t('features.thinking'),
            h('select', {
              style: { ...S.select, flex: '0 0 auto' },
              value: draft.defaultThinkingLevel || '',
              onChange: (event) => setDraft(Object.assign({}, draft, { defaultThinkingLevel: event.target.value || undefined })),
            }, THINKING_LEVELS.map((level) => h('option', {
              key: level || 'default', value: level, style: S.option,
            }, level ? t('thinking.' + level) : t('common.default'))))),
          h('label', { style: { ...S.label, display: 'flex', alignItems: 'center', gap: '6px' } }, t('features.aspect'),
            h('select', {
              style: { ...S.select, flex: '0 0 auto' },
              value: draft.imageAspectRatio || '1:1',
              onChange: (event) => setDraft(Object.assign({}, draft, { imageAspectRatio: event.target.value })),
            }, ASPECT_RATIOS.map((ratio) => h('option', { key: ratio, value: ratio, style: S.option }, ratio)))),
          h('button', { type: 'button', style: S.buttonPrimary, disabled: busy, onClick: save }, busy ? t('common.saving') : t('common.save'))),
        message ? h('div', { style: { ...S.muted, marginTop: '8px', color: COLOR.ok } }, t('features.saved', { features: message })) : null,
        error ? h('div', { style: { ...S.error, marginTop: '8px' } }, error) : null,
        h('div', { style: { ...S.muted, marginTop: '8px' } },
          t('features.noteSave') + ' ' + t('features.notePaths')));
    }
    function TestImageSection() {
      const [prompt, setPrompt] = React.useState(t('image.defaultPrompt'));
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
          if (!json.ok) throw new Error((json.code ? json.code + ': ' : '') + (json.error || t('image.failed')));
          setResult(json);
        } catch (failure) {
          setError(String(failure && failure.message ? failure.message : failure));
        } finally {
          setBusy(false);
        }
      }, [prompt]);
      return h(Card, { title: t('image.title') },
        h('div', { style: { ...S.row, marginBottom: '8px' } },
          h('input', {
            style: S.input, value: prompt, placeholder: t('image.placeholder'),
            onChange: (event) => setPrompt(event.target.value),
          }),
          h('button', { style: S.buttonPrimary, disabled: busy, onClick: run, type: 'button' },
            busy ? t('image.generating') : t('image.run'))),
        error ? h('div', { style: S.error }, error) : null,
        result ? h('div', null,
          result.images.map((image) => h('div', { key: image.name },
            h('img', {
              src: image.previewUrl || ('/antigravity/media/' + encodeURIComponent(image.name)),
              alt: image.name, style: S.preview,
            }),
            h('div', { style: S.mono }, image.path + ' · ' + image.bytes + ' B' +
              (image.durable ? ' · durable' : '')))),
          result.text ? h('div', { style: S.muted }, result.text) : null) : null,
        h('div', { style: { ...S.muted, marginTop: '8px' } },
          t('image.note')));
    }

    function TestSearchSection() {
      const [query, setQuery] = React.useState(t('search.defaultQuery'));
      const [busy, setBusy] = React.useState(false);
      const [result, setResult] = React.useState(null);
      const [error, setError] = React.useState(null);
      const run = React.useCallback(async () => {
        setBusy(true); setError(null); setResult(null);
        try {
          const response = await fetch('/antigravity/test-search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query }),
          });
          const json = await response.json();
          if (!json.ok) throw new Error((json.code ? json.code + ': ' : '') + (json.error || t('search.failed')));
          setResult(json);
        } catch (failure) {
          setError(String(failure && failure.message ? failure.message : failure));
        } finally {
          setBusy(false);
        }
      }, [query]);
      return h(Card, { title: t('search.title') },
        h('div', { style: { ...S.row, marginBottom: '8px' } },
          h('input', {
            style: S.input, value: query, placeholder: t('search.placeholder'),
            onChange: (event) => setQuery(event.target.value),
          }),
          h('button', { style: S.buttonPrimary, disabled: busy, onClick: run, type: 'button' },
            busy ? t('search.running') : t('search.run'))),
        error ? h('div', { style: S.error }, error) : null,
        result ? h('div', null,
          h('div', { style: S.value }, result.answer),
          (result.queries || []).length
            ? h('div', { style: { ...S.mono, marginTop: '6px' } }, t('search.queries', { list: result.queries.join(' | ') }))
            : null,
          (result.sources || []).map((source, index) => h('div', { key: source.uri + index, style: S.muted },
            '[' + (index + 1) + '] ',
            h('a', { href: source.uri, target: '_blank', rel: 'noreferrer', style: { color: COLOR.brand } }, source.title))))
          : null,
        h('div', { style: { ...S.muted, marginTop: '8px' } },
          t('search.note')));
    }

    function AccountSection(props) {
      const account = props.account || {};
      const rows = [
        [t('account.tier'), account.tierName || account.tier || '—'],
        [t('account.project'), account.project || '—'],
        [t('account.paidTier'), account.paidTier || '—'],
        ['API', props.upstream || '—'],
        [t('account.credentials'), props.credentialTarget || '—'],
        ['User-Agent', props.userAgent || '—'],
      ];
      return h(Card, { title: t('account.title') },
        rows.map(([label, value]) => h('div', { key: label, style: { ...S.row, justifyContent: 'space-between', padding: '3px 0' } },
          h('span', { style: S.label }, label),
          h('span', { style: { ...S.value, textAlign: 'right' } }, value))),
        props.accountsError ? h('div', { style: { ...S.muted, marginTop: '6px' } }, 'loadCodeAssist: ' + props.accountsError) : null);
    }

    function RuntimeSection(props) {
      const plugin = props.plugin || {};
      const limits = props.limits || {};
      const throttle = plugin.throttle || {};
      const lastError = plugin.lastError;
      const rows = [
        [t('runtime.version'), plugin.version || '—'],
        [t('runtime.tools'), (plugin.tools || []).join(', ') || t('common.none')],
        [t('runtime.maxConcurrent'), String(limits.maxConcurrentRequests ?? throttle.maxConcurrent ?? '—')],
        [t('runtime.minInterval'), t('runtime.intervalValue', { value: limits.minRequestIntervalMs ?? throttle.minIntervalMs ?? 0 })],
        [t('runtime.cooldown'), t('runtime.cooldownValue', { value: Math.round((limits.rateLimitCooldownMs ?? throttle.cooldownMs ?? 0) / 1000) })],
        [t('runtime.active'), t('runtime.queueValue', { active: String(throttle.active ?? 0), queued: String(throttle.queued ?? 0) })],
      ];
      return h(Card, { title: t('runtime.title') },
        rows.map(([label, value]) => h('div', { key: label, style: { ...S.row, justifyContent: 'space-between', padding: '3px 0' } },
          h('span', { style: S.label }, label),
          h('span', { style: { ...S.value, textAlign: 'right' } }, value))),
        throttle.cooldownUntil
          ? h('div', { style: { ...S.muted, marginTop: '6px', color: COLOR.warn } },
            t('runtime.cooldownUntil', { time: formatTime(throttle.cooldownUntil) }))
          : null,
        lastError
          ? h('div', { style: { ...S.error, marginTop: '8px' } },
            t('runtime.lastError', { time: formatTime(lastError.at), code: lastError.code, message: lastError.message }))
          : null);
    }

    function AntigravitySettings() {
      const status = useStatus();
      const data = status.data || {};
      const plugin = data.plugin || {};
      return h('div', { style: S.root },
        h('div', { style: S.header },
          h('div', null,
            h('h2', { style: S.title }, 'Antigravity' + (plugin.version ? ' v' + plugin.version : '')),
            h('p', { style: S.subtitle },
              t('page.subtitle'),
              data.at ? ' ' + t('page.dataAt', { time: formatTime(data.at) }) + (status.cached ? ' ' + t('page.cached') : '') : '')),
          h('button', { type: 'button', style: S.button, disabled: status.busy, onClick: () => status.reload(true) },
            status.busy ? t('common.refreshing') : t('common.refresh'))),
        status.error ? h('div', { style: S.error }, t('page.apiUnavailable', { error: status.error })) : null,
        status.phase === 'loading' ? h('div', { style: S.muted }, t('common.loading')) : null,
        status.phase !== 'loading' ? h(AccountSection, {
          account: data.account, accountsError: data.accountsError,
          upstream: data.upstream, credentialTarget: data.credentialTarget, userAgent: data.userAgent,
        }) : null,
        status.phase !== 'loading' ? h(QuotaSection, { quotas: data.quotas, error: data.quotasError }) : null,
        status.phase !== 'loading' ? h(ModelsSection, { models: data.models, error: data.modelsError }) : null,
        status.phase !== 'loading' ? h(FeaturesSection, { features: data.features, onSaved: () => status.reload(false) }) : null,
        status.phase !== 'loading' ? h(RuntimeSection, { plugin, limits: data.limits }) : null,
        h(TestSearchSection),
        h(TestImageSection));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // Optional services are read with ctx.get(), never as ctx.<name>: Cordis throws
        // 'cannot get property "<name>" without inject' for a non-injected service, and a
        // throw here fails the whole web boot ("entry did not activate"). Every step below is
        // also individually defensive for the same reason.
        try {
          const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined;
          if (locale && typeof locale.register === 'function') {
            try {
              // A composition without ctx.effect (or a second activation) must not fail boot.
              if (typeof ctx.effect === 'function') ctx.effect(() => locale.register(NS, LOCALE));
              else locale.register(NS, LOCALE);
            } catch (error) {
              try { console.error('antigravity: locale registration skipped', error); } catch { /* no console */ }
            }
            try { t = locale.bind(NS); } catch { /* keep the English fallback */ }
          }
        } catch (error) {
          try { console.error('antigravity: locale service unavailable', error); } catch { /* no console */ }
        }
        try {
          ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section',
            id: 'antigravity',
            order: 30,
            label: 'Antigravity',
          }, AntigravitySettings));
        } catch (error) {
          try { console.error('antigravity: settings section registration failed', error); } catch { /* no console */ }
        }
      },
    };
  },
});
