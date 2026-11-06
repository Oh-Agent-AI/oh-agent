// A bounded browser host for the production City plugin. Synthetic data only.
(() => {
  const box = document.querySelector('.city-window');
  if (!box) return;
  const stage = box.querySelector('.city-stage');
  const launch = document.getElementById('city-launch');
  const status = document.getElementById('city-status');
  const range = document.getElementById('city-window-days');
  const reset = document.getElementById('city-reset');
  const settings = document.getElementById('city-settings');
  const stop = document.getElementById('city-stop');
  const locale = window.__avLandingLang;
  // The prerendered /zh/ page lives one level down; it sets data-site-root="../".
  const root = document.documentElement?.dataset?.siteRoot || '';
  const t = (key) => locale.t(key);
  let frame = null;
  let instance = '';
  let timer = null;
  let sequence = 0;
  let initialWindowSent = false;
  let receivedWindow = 0;
  let visible = false;
  let generation = 0;
  let fixtureSeed = 74031;
  let autoAttempted = false;

  function projection(days) {
    // Fixed end date and PRNG keep reloads, views and generated cities reproducible.
    const to = Date.parse('2026-10-15T23:59:59Z');
    const from = to - days * 86400000;
    let seed = 20261002;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const harnesses = [
      { id: 'claude_code', display_name: 'Claude Code' }, { id: 'codex', display_name: 'Codex' },
      { id: 'deepseek_harness', display_name: 'DeepSeek Harness' }, { id: 'workbuddy', display_name: 'WorkBuddy' },
    ].map((h) => ({ ...h, capabilities: { session_statistics: { available: true }, findings: { available: false, reason: 'sample_only' } } }));
    // 800 sessions keeps the sample at City scale tier 2. The current planner runs a
    // full road/block plan in a worker; 2000 sessions (tier 5) took ~25 s before the
    // first model frame, longer than the startup timeout, so the hero never left loading.
    const all = Array.from({ length: 800 }, (_, i) => {
      const start = to - (i % 30) * 86400000 - Math.floor(rnd() * 72000000) - 7200000;
      const end = start + (10 + Math.floor(rnd() * 75)) * 60000;
      const total = Math.floor(50000 + Math.pow(rnd(), 2) * 4000000);
      const input = Math.floor(total * .8);
      return { id: `landing-sample-${i + 1}`, harness: harnesses[i % 4].id,
        first_event_at: new Date(start).toISOString(), last_event_at: new Date(end).toISOString(),
        tokens: { input, output: total - input, total }, event_count: 15 + Math.floor(rnd() * 200) };
    });
    const sessions = all.filter((s) => Date.parse(s.last_event_at) >= from);
    return { protocol: 'city:v2', source: 'fixture', data_revision: 1, harnesses,
      generated_at: new Date(to).toISOString(),
      window: { days, label: locale.lang === 'zh' ? `样例 · ${days} 天` : `Sample · ${days} days`, from: new Date(from).toISOString(), to: new Date(to).toISOString() },
      sessions, findings: [], status: 'ready',
      coverage: { total: sessions.length, returned: sessions.length, truncated: false, unknown_time: 0, findings_state: 'unavailable' } };
  }

  function post(type, extra = {}) {
    frame?.contentWindow?.postMessage({ channel: 'av-plugin-rpc', version: 1, instanceId: instance, type, ...extra }, location.origin);
  }
  function command(commandId, value) {
    post('command', { command: { version: 1, instanceId: instance, requestId: `landing-command-${++sequence}`, commandId, ...(value === undefined ? {} : { value }) } });
  }
  function state(value, message) {
    box.dataset.cityState = value;
    if (message) status.textContent = message;
    launch.disabled = value === 'loading';
    launch.textContent = t(value === 'loading' ? 'city.loading' : value === 'error' ? 'city.retry' : 'city.launch.button');
    range.disabled = reset.disabled = settings.disabled = value !== 'ready';
    stop.disabled = !frame;
  }
  function cleanup() {
    clearTimeout(timer);
    frame?.remove();
    frame = null;
    generation++;
    initialWindowSent = false;
    receivedWindow = 0;
  }
  function fail(key = 'city.error') {
    cleanup();
    state('error', t(key));
  }
  function syncVisibility() {
    if (!frame || box.dataset.cityState !== 'ready') return;
    post(document.hidden || !visible ? 'suspend' : 'resume');
  }
  function respond(requestId, result) { post('response', { requestId, result }); }
  function onMessage(event) {
    const m = event.data;
    if (!frame || event.source !== frame.contentWindow || event.origin !== location.origin ||
      m?.channel !== 'av-plugin-rpc' || m.version !== 1 || m.instanceId !== instance || m.type !== 'request') return;
    if (m.command === 'plugin_request') {
      const r = m.args?.request;
      if (r?.version !== 1 || r.instanceId !== instance || typeof r.requestId !== 'string') return;
      let result = null;
      if (r.method === 'data.read' && r.payload?.projection === 'city' && r.payload.version === 2 && [7, 30, 90, 366].includes(r.payload.windowDays)) {
        receivedWindow = r.payload.windowDays;
        // Settings inside the production view can change the same time window.
        if (initialWindowSent && box.dataset.cityState === 'ready') {
          range.value = String(receivedWindow);
        }
        result = projection(receivedWindow);
      } else if (r.method === 'data.read' && r.payload?.projection === 'city-settings' && r.payload.version === 1) {
        if (r.payload.action === 'read') result = { seed: fixtureSeed };
        if (r.payload.action === 'write' && Number.isInteger(r.payload.seed) && r.payload.seed > 0 && r.payload.seed <= 4294967295) {
          fixtureSeed = r.payload.seed;
          result = { seed: fixtureSeed };
        }
      }
      respond(m.requestId, { version: 1, requestId: r.requestId, ok: result !== null, result,
        error: result ? null : { code: 'landing_method_unavailable', retryable: false } });
    } else if (m.command === 'plugin_message') {
      const message = m.args?.message;
      if (message?.version !== 1 || message.instanceId !== instance) return;
      respond(m.requestId, { version: 1, requestId: '', ok: true, result: null, error: null });
      if (message.type === 'runtime.error') { fail(); return; }
      if (message.type === 'toolbar.update' && Array.isArray(message.items)) {
        const usable = message.items.some((item) => item.commandId === 'city.reset' && item.enabled);
        if (!usable) {
          // The first toolbar update (before the scene is built) and terrain rebuilds
          // report reset as disabled. That means "still loading", not a crash: only
          // runtime.error and the startup timeout are failures.
          if (initialWindowSent) reset.disabled = true;
          return;
        }
        if (!initialWindowSent) {
          initialWindowSent = true;
          command('city.quality', 'eco');
          // The production app initially requests its own default (366 days).
          // Apply the selected sample window only after its command listener is ready.
          if (receivedWindow !== Number(range.value)) { command('city.window', range.value); return; }
        }
        if (receivedWindow === Number(range.value)) {
          clearTimeout(timer);
          state('ready');
          syncVisibility();
        }
      }
    } else post('response', { requestId: m.requestId, error: 'landing_command_unavailable' });
  }

  function mount() {
    if (frame || box.dataset.cityState === 'loading') return;
    autoAttempted = true;
    state('loading', t('city.loading'));
    const attempt = ++generation;
    instance = `av-landing-city-${attempt}`;
    // The City overlay shows live planner progress, so allow slow machines time to finish.
    timer = setTimeout(() => { if (generation === attempt) fail('city.timeout'); }, 60000);
    // Request the directory URL directly: Cloudflare Pages 308-redirects /city3d/index.html to /city3d/.
    fetch(`${root}city3d/`, { method: 'HEAD', credentials: 'omit' }).then((response) => {
      if (generation !== attempt) return;
      if (!response.ok) { fail(); return; }
      frame = document.createElement('iframe');
      frame.id = 'city-frame';
      frame.title = locale.lang === 'zh' ? 'Agent City 样例城市 · 模拟数据' : 'Agent City sample · synthetic data';
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
      frame.referrerPolicy = 'no-referrer';
      frame.src = `${root}city3d/?instanceId=${encodeURIComponent(instance)}&locale=${locale.lang === 'zh' ? 'zh-Hans' : 'en'}&presentation=landing&windowDays=${range.value}`;
      frame.addEventListener('error', () => { if (generation === attempt) fail(); }, { once: true });
      stage.append(frame);
      stop.disabled = false;
    }).catch(() => { if (generation === attempt) fail(); });
  }
  if (location.protocol === 'file:') {
    state('local-file', t('city.localFile'));
    launch.textContent = t('city.localFile.button');
    launch.disabled = true;
    return;
  }
  launch.addEventListener('click', mount);
  window.addEventListener('av:explore-city', mount);
  window.addEventListener('message', onMessage);
  reset.addEventListener('click', () => command('city.reset'));
  settings.addEventListener('click', () => command('city.settings'));
  stop.addEventListener('click', () => { cleanup(); state('idle', t('city.launch.body')); launch.focus({ preventScroll: true }); });
  range.addEventListener('change', () => {
    state('loading', t('city.updating'));
    command('city.window', range.value);
    clearTimeout(timer);
    timer = setTimeout(() => fail('city.timeout'), 60000);
  });
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    // Desktop gets the real City frontend in the hero. Narrow/reduced-motion
    // views retain a deliberate entry action, and closing never auto-reopens it.
    if (visible && !document.hidden && !autoAttempted && matchMedia('(min-width: 601px)').matches
      && !matchMedia('(prefers-reduced-motion: reduce)').matches && !window.navigator?.connection?.saveData) {
      autoAttempted = true;
      mount();
    }
    syncVisibility();
  }, { threshold: .05 }).observe(stage);
  document.addEventListener('visibilitychange', syncVisibility);
  window.addEventListener('pagehide', cleanup);
})();
