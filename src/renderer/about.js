'use strict';

const page = window.verityPage;

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
  return node;
}

const kv = (label, value) => el('div', { class: 'kv' }, el('span', { text: label }), el('b', { text: String(value) }));

const DEFAULTS = [
  ['Ephemeral session', 'Windows run in an in-memory partition, so history, cookies and cache are discarded when Verity exits.'],
  ['Filter list', 'Ads, trackers, session recorders, fingerprinting scripts and cryptominers are blocked before the request is sent.'],
  ['Third-party cookies', 'Stripped from sub-resources and sub-frames, and never stored from a reply. Documents keep their own cookies so logins still work.'],
  ['HTTPS-only', 'Plain HTTP is upgraded; if the site refuses TLS, Verity shows an interstitial instead of downgrading you quietly.'],
  ['Tracking parameters', 'utm_*, fbclid, gclid, msclkid, igshid and friends are removed from links before they are followed.'],
  ['Fingerprint surface', 'A clean user agent, coarse client hints only, and no cross-site referrer.'],
  ['Permissions', 'Camera, microphone, location, notifications and the rest are denied unless you allow them per site.'],
  ['Certificates', 'Invalid certificates are refused and cannot be clicked through.'],
];

const ENGINE = [
  ['Request filtering', 'Every session installs an onBeforeRequest rule: the hostname is matched against the filter list on domain boundaries, so doubleclick.net covers ads.doubleclick.net but never notdoubleclick.net.'],
  ['Per-tab accounting', 'Blocks are attributed to the tab that caused them, which is what the shield panel and its per-page counter display.'],
  ['Exceptions', 'Turning a protection off in the shield panel writes a per-host exception, so unbreaking one site cannot weaken the rest.'],
  ['Isolation', 'The chrome UI, each window and each tab run in separate Electron sessions, and only Verity’s own pages get a preload bridge.'],
];

const SHORTCUTS = [
  ['New tab / close tab', 'Ctrl+T · Ctrl+W'],
  ['Reopen the last closed tab', 'Ctrl+Shift+T'],
  ['Address bar', 'Ctrl+L'],
  ['Next / previous tab', 'Ctrl+Tab · Ctrl+Shift+Tab'],
  ['Back / forward', 'Alt+← · Alt+→'],
  ['Reload · force reload', 'Ctrl+R · Ctrl+Shift+R'],
  ['Find in page', 'Ctrl+F · F3'],
  ['Zoom in / out / reset', 'Ctrl+= · Ctrl+- · Ctrl+0'],
  ['Shield panel', 'Ctrl+Shift+Y'],
  ['Settings', 'Ctrl+,'],
  ['Clear data for this window', 'Ctrl+Shift+Delete'],
];

async function render() {
  const result = page ? await page.summary() : { ok: false };
  const versions = (result.ok && result.versions) || {};

  document.getElementById('build').append(
    kv('Verity', versions.app || '0.1.0'),
    kv('Electron', versions.electron || '—'),
    kv('Chromium', versions.chrome || '—'),
    kv('Node', versions.node || '—'),
    kv('Platform', versions.platform || navigator.platform || '—'),
    // Which data directory this instance is using: 'default', or the name given
    // on the command line with --profile.
    kv('Profile', result.profile || 'default')
  );

  const defaults = document.getElementById('defaults');
  for (const [label, text] of DEFAULTS) defaults.append(el('li', {}, el('b', { text: label }), ` — ${text}`));

  const engine = document.getElementById('engine');
  for (const [label, text] of ENGINE) engine.append(el('li', {}, el('b', { text: label }), ` — ${text}`));

  const shortcuts = document.getElementById('shortcuts');
  for (const [label, keys] of SHORTCUTS) shortcuts.append(el('li', {}, el('b', { text: label }), ` — ${keys}`));

  if (result.ok && result.settings) {
    const badge = document.getElementById('mode-badge');
    badge.textContent = result.settings.ephemeralMode ? 'private session · nothing on disk' : 'persistent profile';
  }

  const profile = result.profile || 'default';
  const note = document.getElementById('profile-note');
  if (note && profile !== 'default') {
    note.textContent = `This instance is running the "${profile}" profile, so its settings and bookmarks are kept apart from every other copy.`;
    note.hidden = false;
  }
}

const face = document.getElementById('verity-face');
if (face && globalThis.verityMascot) face.innerHTML = globalThis.verityMascot({ size: 108 });
const favicon = document.getElementById('favicon');
if (favicon && globalThis.verityFavicon) favicon.href = globalThis.verityFavicon();

render();
