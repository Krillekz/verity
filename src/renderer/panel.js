'use strict';

/**
 * Verity side panel renderer.
 *
 * Runs in its own WebContentsView (`verity://panel?view=shield|bookmarks|settings|menu`).
 * It owns the privacy surfaces: the shield report with its per-site exceptions,
 * the full settings list, bookmarks and the main menu.
 */

const api = window.verity;
const ICONS = globalThis.VERITY_ICONS;

const SEARCH_LABELS = {
  duckduckgo: 'DuckDuckGo',
  startpage: 'Startpage',
  brave: 'Brave Search',
  mojeek: 'Mojeek',
  wikipedia: 'Wikipedia',
  google: 'Google',
};

const THEME_LABELS = { system: 'Match system', dark: 'Dark', light: 'Light' };

const SETTING_TOGGLES = [
  { key: 'ephemeralMode', label: 'Ephemeral mode', desc: 'New windows keep nothing on disk. Applies to windows opened after the change.' },
  { key: 'clearOnExit', label: 'Clear data when quitting', desc: 'Wipe storage and cache as Verity exits.' },
  { key: 'httpsOnly', label: 'HTTPS-only mode', desc: 'Upgrade every plain HTTP connection, or refuse it.' },
  { key: 'blockAdsTrackers', label: 'Block ads & trackers', desc: 'Filter list applied to every request in every tab.' },
  { key: 'blockThirdPartyCookies', label: 'Block third-party cookies', desc: 'Never send cookies to another site, never store theirs.' },
  { key: 'stripTrackingParams', label: 'Strip tracking parameters', desc: 'Removes utm_*, fbclid, gclid and friends from links.' },
  { key: 'reduceFingerprinting', label: 'Reduce fingerprinting', desc: 'Clean user agent, coarse client hints, no cross-site referrer.' },
  { key: 'sendDoNotTrack', label: 'Send Do Not Track and GPC', desc: 'Asks sites not to sell or share your data.' },
  { key: 'denyPermissionsByDefault', label: 'Deny permissions by default', desc: 'Camera, microphone, location and notifications stay off.' },
  { key: 'showBookmarksBar', label: 'Show bookmarks bar', desc: '' },
];

const state = {
  view: new URLSearchParams(location.search).get('view') || 'shield',
  settings: null,
  bookmarks: [],
  rerenderTimer: null,
};

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    // `html` is only ever called with the static icon set.
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'style') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
  return node;
}

const body = document.getElementById('body');

/**
 * Follow the browser theme.
 *
 * The panel document defaults to dark, but the theme lives in settings: a panel
 * painted from the document default would disagree with the strip and the page
 * sitting right next to it.
 */
function applyTheme(settings) {
  document.documentElement.dataset.theme = (settings && settings.theme) || 'system';
}

/** `icon` is trusted markup from icons.js; `title` is always text. */
function setHead(icon, title) {
  document.getElementById('head-icon').innerHTML = icon;
  document.getElementById('head-title').textContent = title;
}

function kvRow(label, value) {
  return h('div', { class: 'kv' }, h('span', { text: label }), h('b', { text: String(value) }));
}

function switchRow({ label, desc, checked, onChange }) {
  return h(
    'div',
    { class: 'row' },
    h(
      'span',
      { class: 'row-text' },
      h('span', { class: 'row-label', text: label }),
      desc ? h('span', { class: 'row-desc', text: desc }) : null
    ),
    h('button', {
      class: `switch${checked ? ' on' : ''}`,
      type: 'button',
      role: 'switch',
      'aria-checked': checked ? 'true' : 'false',
      'aria-label': label,
      onclick: () => onChange(!checked),
    })
  );
}

function closePanel() {
  api.panels.hide();
}

// ------------------------------------------------------------------- shield

async function renderShield() {
  // The privacy report is the one panel the face belongs on: it is the thing
  // watching your traffic for you.
  setHead(globalThis.verityMark ? globalThis.verityMark({ size: 22 }) : ICONS.shieldCheck, 'Shield');
  body.textContent = '';
  const result = await api.privacy.report();
  if (!result.ok) {
    body.append(h('p', { class: 'panel-error', text: 'Could not read the privacy report.' }));
    return;
  }
  const report = result.report;
  const blocked = report.blocked || { count: 0, domains: [] };
  const summary = report.summary || {};

  body.append(
    h(
      'div',
      { class: 'panel-section' },
      h(
        'div',
        { class: 'stat-row' },
        h('span', { class: 'stat-big', text: String(blocked.count) }),
        h('span', {
          class: 'stat-label',
          text: `blocked request${blocked.count === 1 ? '' : 's'} on this page`,
        })
      ),
      h('div', { class: 'meter' }, h('span', { style: { width: `${Math.min(100, blocked.count * 5)}%` } }))
    )
  );

  if (blocked.domains && blocked.domains.length) {
    body.append(
      h(
        'div',
        { class: 'panel-section' },
        h('h3', { text: 'Blocked here' }),
        h(
          'ul',
          { class: 'domain-list' },
          blocked.domains.slice(0, 40).map((item) =>
            h(
              'li',
              {},
              h('span', { class: 'domain', text: item.domain }),
              h('span', { class: 'cat', text: item.category || 'ads' }),
              h('span', { class: 'count', text: `×${item.count}` })
            )
          )
        )
      )
    );
  } else {
    body.append(h('p', { class: 'note', text: 'Nothing has been blocked on this page yet.' }));
  }

  const host = report.host;
  if (host) {
    const exception = report.exception || {};
    body.append(
      h(
        'div',
        { class: 'panel-section' },
        h('h3', { text: `For ${host}` }),
        switchRow({
          label: 'Block ads & trackers',
          desc: 'Turn off if a site will not work with filtering.',
          checked: exception.blocking !== false,
          onChange: (value) => setException(host, { blocking: value }),
        }),
        switchRow({
          label: 'HTTPS-only',
          desc: 'Refuse plain HTTP connections to this host.',
          checked: exception.httpsOnly !== false,
          onChange: (value) => setException(host, { httpsOnly: value }),
        }),
        switchRow({
          label: 'Block third-party cookies',
          desc: 'Drop cookies set or sent by other sites.',
          checked: exception.thirdPartyCookies !== false,
          onChange: (value) => setException(host, { thirdPartyCookies: value }),
        }),
        switchRow({
          label: 'Allow permission prompts',
          desc: 'Camera, microphone, location, notifications.',
          checked: exception.permissions === true,
          onChange: (value) => setException(host, { permissions: value }),
        }),
        h(
          'div',
          { class: 'btn-row', style: { marginTop: '10px' } },
          h('button', { class: 'btn', type: 'button', onclick: () => clearSiteData(host) }, 'Clear data for this site')
        )
      )
    );
  }

  body.append(
    h(
      'div',
      { class: 'panel-section' },
      h('h3', { text: 'This session' }),
      kvRow('Requests blocked', summary.blocked || 0),
      kvRow('Upgraded to HTTPS', summary.upgraded || 0),
      kvRow('Tracking parameters removed', summary.parametersStripped || 0),
      kvRow('Third-party cookies dropped', summary.cookiesBlocked || 0),
      kvRow('Filter list rules', (report.filterList || {}).total || 0)
    )
  );

  body.append(
    h(
      'div',
      { class: 'panel-section' },
      h(
        'div',
        { class: 'btn-row' },
        h('button', { class: 'btn danger', type: 'button', onclick: clearEverything }, 'Clear all data'),
        h('button', { class: 'btn', type: 'button', onclick: () => openView('settings') }, 'All settings')
      )
    )
  );
}

async function setException(host, patch) {
  await api.privacy.setException(host, patch);
  scheduleRender();
}

async function clearSiteData(host) {
  await api.privacy.clearSite(host);
  console.log(`[panel] cleared stored data for ${host}`);
}

async function clearEverything() {
  const result = await api.privacy.clearAll();
  console.log(`[panel] clear all: ${result.ok ? 'ok' : 'partial'}`);
  scheduleRender();
}

// ---------------------------------------------------------------- bookmarks

async function renderBookmarks() {
  setHead(ICONS.bookmarks, 'Bookmarks');
  body.textContent = '';
  const result = await api.bookmarks.list();
  state.bookmarks = result.ok ? result.bookmarks || [] : [];

  if (!state.bookmarks.length) {
    body.append(h('p', { class: 'note', text: 'No bookmarks yet. Use the star in the address bar.' }));
    return;
  }
  body.append(
    h(
      'div',
      { class: 'panel-section' },
      h('h3', { text: `${state.bookmarks.length} saved` }),
      state.bookmarks.map((bookmark) =>
        h(
          'div',
          { class: 'row' },
          h(
            'span',
            { class: 'row-text' },
            h('span', { class: 'row-label', text: bookmark.title || bookmark.url }),
            h('span', { class: 'row-desc', text: bookmark.url })
          ),
          h('button', {
            class: 'icon-btn small',
            type: 'button',
            'aria-label': 'Open bookmark',
            html: ICONS.arrowRight,
            onclick: () => {
              api.nav.go(bookmark.url);
              closePanel();
            },
          }),
          h('button', {
            class: 'icon-btn small',
            type: 'button',
            'aria-label': 'Remove bookmark',
            html: ICONS.trash,
            onclick: async () => {
              await api.bookmarks.remove(bookmark.url);
              renderBookmarks();
            },
          })
        )
      )
    )
  );
}

// ----------------------------------------------------------------- settings

async function renderSettings() {
  setHead(ICONS.gear, 'Settings');
  body.textContent = '';
  const result = await api.settings.get();
  state.settings = result.ok ? result.settings : {};
  const settings = state.settings;

  body.append(
    h(
      'div',
      { class: 'panel-section' },
      h('h3', { text: 'Search & start page' }),
      h(
        'label',
        { class: 'row' },
        h('span', { class: 'row-text' }, h('span', { class: 'row-label', text: 'Search engine' })),
        h(
          'select',
          { onchange: (event) => saveSetting('searchEngine', event.target.value) },
          ...Object.entries(SEARCH_LABELS).map(([value, label]) =>
            h('option', { value, selected: settings.searchEngine === value, text: label })
          )
        )
      ),
      h(
        'label',
        { class: 'row' },
        h('span', { class: 'row-text' }, h('span', { class: 'row-label', text: 'Homepage' })),
        h('input', {
          class: 'panel-input',
          type: 'text',
          value: settings.homepage || '',
          onchange: (event) => saveSetting('homepage', event.target.value),
        })
      ),
      h(
        'label',
        { class: 'row' },
        h('span', { class: 'row-text' }, h('span', { class: 'row-label', text: 'Appearance' })),
        h(
          'select',
          { onchange: (event) => saveSetting('theme', event.target.value) },
          ...Object.entries(THEME_LABELS).map(([value, label]) =>
            h('option', { value, selected: settings.theme === value, text: label })
          )
        )
      )
    )
  );

  body.append(
    h(
      'div',
      { class: 'panel-section' },
      h('h3', { text: 'Privacy' }),
      SETTING_TOGGLES.map((toggle) =>
        switchRow({
          label: toggle.label,
          desc: toggle.desc,
          checked: Boolean(settings[toggle.key]),
          onChange: (value) => saveSetting(toggle.key, value),
        })
      )
    )
  );

  const info = await api.privacy.blocklistInfo();
  body.append(
    h(
      'div',
      { class: 'panel-section' },
      h('h3', { text: 'Filter list' }),
      kvRow('Built-in rules', info.ok ? info.info.total - info.info.custom : '—'),
      kvRow('Your rules', info.ok ? info.info.custom : 0),
      h('input', {
        class: 'panel-input',
        type: 'text',
        id: 'filter-url',
        placeholder: 'https://example.com/hosts.txt',
        value: settings.customBlocklistUrl || '',
        style: { marginTop: '8px' },
      }),
      h(
        'div',
        { class: 'btn-row', style: { marginTop: '8px' } },
        h('button', { class: 'btn', type: 'button', onclick: updateFilterList }, 'Load extra rules'),
        h('button', {
          class: 'btn ghost',
          type: 'button',
          onclick: () => saveSetting('customBlocklistUrl', ''),
        }, 'Clear URL')
      ),
      h('p', {
        class: 'note',
        text: 'Accepts hosts-format or plain domain lists, one per line. Rules match on hostname boundaries.',
      })
    )
  );

  body.append(
    h(
      'div',
      { class: 'panel-section' },
      h('h3', { text: 'Data' }),
      h(
        'div',
        { class: 'btn-row' },
        h('button', { class: 'btn danger', type: 'button', onclick: clearEverything }, 'Clear all browsing data'),
        h('button', { class: 'btn', type: 'button', onclick: () => api.ui.openDevTools() }, 'Developer tools')
      ),
      h('p', {
        class: 'note',
        text: `Verity · Electron ${api.versions.electron} · Chromium ${api.versions.chrome}`,
      })
    )
  );
}

async function saveSetting(key, value) {
  const result = await api.settings.set(key, value);
  if (result.ok) state.settings = result.settings;
  scheduleRender();
}

async function updateFilterList() {
  const field = document.getElementById('filter-url');
  const result = await api.settings.updateFilterList(field ? field.value.trim() : '');
  if (!result.ok) console.log(`[panel] filter list error: ${result.error}`);
  else console.log(`[panel] added ${result.added} rule(s)`);
  scheduleRender();
}

// --------------------------------------------------------------------- menu

function renderMenu() {
  setHead(ICONS.menu, 'Menu');
  body.textContent = '';
  const items = [
    { icon: ICONS.plus, label: 'New tab', shortcut: 'Ctrl+T', run: () => api.tabs.create({}) },
    { icon: ICONS.bookmarks, label: 'Bookmarks', shortcut: 'Ctrl+Shift+O', run: () => openView('bookmarks') },
    { icon: ICONS.shieldCheck, label: 'Shield', shortcut: 'Ctrl+Shift+Y', run: () => openView('shield') },
    { icon: ICONS.gear, label: 'Settings', shortcut: 'Ctrl+,', run: () => openView('settings') },
    { icon: ICONS.trash, label: 'Clear browsing data', shortcut: 'Ctrl+Shift+Del', run: clearEverything },
    { icon: ICONS.bolt, label: 'Toggle ephemeral mode', shortcut: '', run: () => api.nav.command('toggle-ephemeral') },
    { icon: ICONS.info, label: 'About Verity', shortcut: '', run: () => api.tabs.create({ url: 'verity://about' }) },
    { icon: ICONS.external, label: 'Quit Verity', shortcut: 'Ctrl+Q', run: () => api.nav.command('quit') },
  ];

  body.append(
    h(
      'div',
      { class: 'panel-section' },
      items.map((item) =>
        h(
          'button',
          {
            class: 'menu-item',
            type: 'button',
            onclick: () => {
              const keepOpen = item.label === 'Clear browsing data';
              item.run();
              if (!keepOpen) closePanel();
            },
          },
          h('span', { html: item.icon, style: { display: 'grid' } }),
          h('span', { text: item.label }),
          item.shortcut ? h('span', { class: 'shortcut', text: item.shortcut }) : null
        )
      )
    )
  );
}

// -------------------------------------------------------------------- boot

function scheduleRender() {
  clearTimeout(state.rerenderTimer);
  state.rerenderTimer = setTimeout(render, 250);
}

async function openView(view) {
  await api.panels.show(view);
  state.view = view;
  render();
}

async function render() {
  try {
    if (state.view === 'bookmarks') await renderBookmarks();
    else if (state.view === 'settings') await renderSettings();
    else if (state.view === 'menu') renderMenu();
    else await renderShield();
  } catch (err) {
    body.textContent = '';
    body.append(h('p', { class: 'panel-error', text: `Panel failed to render: ${err.message}` }));
  }
}

document.getElementById('close').innerHTML = ICONS.close;
document.getElementById('close').addEventListener('click', closePanel);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closePanel();
});

if (api && typeof api.on === 'function') {
  api.on((payload) => {
    if (!payload) return;
    if (payload.type === 'blocked-request' && state.view === 'shield') scheduleRender();
    if (payload.type === 'settings-changed') {
      applyTheme(payload.settings);
      if (state.view === 'settings') state.settings = payload.settings;
    }
  });
}

// Ask for the theme before the first paint, so the drawer matches the strip.
api.settings
  .get()
  .then((result) => applyTheme(result.ok ? result.settings : null))
  .catch(() => {});

render();
