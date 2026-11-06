// Navigation works independently of the optional 3D runtime. No analytics.
(() => {
  document.querySelectorAll('[data-start-city]').forEach((link) => {
    link.addEventListener('click', () => window.dispatchEvent(new Event('av:explore-city')));
  });
  // Preview the exploration concept, not an in-browser game launch.
  const world = document.querySelector('.play-world');
  const modes = document.querySelectorAll('[data-exploration-mode]');
  const panels = document.querySelectorAll('[data-exploration-panel]');
  modes.forEach((button) => button.addEventListener('click', () => {
    const mode = button.dataset.explorationMode;
    if (!world || !['flight', 'drive', 'vtol'].includes(mode)) return;
    world.dataset.exploration = mode;
    modes.forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
    panels.forEach((panel) => { panel.hidden = panel.dataset.explorationPanel !== mode; });
  }));
  // Platform hint: highlight the matching download card and point the hero download
  // button at that card's direct link (links live in the HTML, never in this script).
  // Unknown platforms (and phones) keep the button pointing at #download.
  const nav = globalThis.navigator || {};
  const raw = `${nav.userAgentData?.platform || nav.platform || ''} ${nav.userAgent || ''}`.toLowerCase();
  const mobile = nav.userAgentData?.mobile || /android|iphone|ipad|ipod/.test(raw);
  const platform = mobile || /cros|chrome os/.test(raw) ? '' : /mac/.test(raw) ? 'mac' : /win/.test(raw) ? 'windows' : /linux|x11/.test(raw) ? 'linux' : '';
  const card = platform ? document.querySelector(`[data-platform="${platform}"]`) : null;
  const direct = card?.querySelector('.platform-downloads a');
  const hero = document.getElementById?.('hero-download');
  if (!card || !direct || !hero) return;
  document.documentElement.dataset.platform = platform;
  card.classList.add('is-detected');
  hero.href = direct.getAttribute('href');
  const note = document.getElementById?.('hero-download-note');
  const line = note?.querySelector(`[data-platform-note="${platform}"]`);
  if (note && line) { note.hidden = false; line.hidden = false; }
})();
