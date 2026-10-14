'use strict';

/** Verity's new tab page. Reads session stats through the guarded page bridge. */

const page = window.verityPage;
const $ = (id) => document.getElementById(id);

const SEARCH_LABELS = {
  duckduckgo: 'DuckDuckGo',
  startpage: 'Startpage',
  brave: 'Brave Search',
  mojeek: 'Mojeek',
  wikipedia: 'Wikipedia',
  google: 'Google',
};

const ICONS = {
  search: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>',
};

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
  return node;
}

function card(value, label, sub, accent) {
  return el(
    'div',
    { class: 'card' },
    el('span', { class: `value${accent ? ' accent' : ''}`, text: String(value) }),
    el('span', { class: 'label', text: label }),
    sub ? el('span', { class: 'sub', text: sub }) : null
  );
}

async function refresh() {
  if (!page) return;
  const result = await page.summary();
  if (!result.ok) return;
  const { summary, filterList, settings } = result;

  const ephemeral = Boolean(settings.ephemeralMode);
  const badge = $('mode-badge');
  badge.textContent = ephemeral ? 'private session · nothing on disk' : 'persistent profile';
  badge.className = `badge${ephemeral ? '' : ' neutral'}`;

  $('lede').textContent = ephemeral
    ? 'This session lives in memory only. Close Verity and it is gone — no history, no cookies, no cache left behind.'
    : 'This window uses an on-disk profile. Turn on ephemeral mode in settings to keep nothing.';

  const engine = SEARCH_LABELS[settings.searchEngine] || 'DuckDuckGo';
  $('query').placeholder = `Search with ${engine}, or enter an address`;
  $('engine-hint').textContent = `Shield active · ${filterList.total} filter rules · HTTPS-only ${settings.httpsOnly ? 'on' : 'off'}`;

  $('cards').textContent = '';
  $('cards').append(
    card(summary.blocked || 0, 'requests blocked', 'ads, trackers, session recorders, miners', true),
    card(summary.upgraded || 0, 'connections upgraded', 'plain HTTP pushed to HTTPS'),
    card(summary.parametersStripped || 0, 'tracking parameters removed', 'utm_*, fbclid, gclid…'),
    card(summary.cookiesBlocked || 0, 'third-party cookies dropped', 'never stored, never sent')
  );

  $('features').textContent = '';
  $('features').append(
    el('li', {}, el('b', { text: 'Requests are filtered' }), ' against a built-in blocklist before they leave your machine.'),
    el('li', {}, el('b', { text: 'Third-party cookies' }), ' are stripped from sub-resources and replies; document logins keep working.'),
    el('li', {}, el('b', { text: 'HTTPS-only' }), ' upgrades plain connections and refuses to downgrade silently.'),
    el('li', {}, el('b', { text: 'Permissions are denied' }), ' by default — camera, microphone, location, notifications.'),
    el('li', {}, el('b', { text: 'Third-party connection attempts' }), ' leak neither your referrer nor fine-grained client hints.')
  );
}

// The mascot and the tab-strip mark both come from icons.js, so every surface
// of the browser shows the same face.
if ($('verity-face') && globalThis.verityMascot) $('verity-face').innerHTML = globalThis.verityMascot({ size: 148 });
if ($('favicon') && globalThis.verityFavicon) $('favicon').href = globalThis.verityFavicon();
if ($('search-icon')) $('search-icon').innerHTML = ICONS.search;

$('search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const value = $('query').value.trim();
  if (value && page) page.navigate(value);
});

$('open-shield').addEventListener('click', () => page && page.openPanel('shield'));
$('open-settings').addEventListener('click', () => page && page.openPanel('settings'));

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh();
});

refresh();
