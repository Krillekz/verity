'use strict';

/**
 * Verity — browser chrome renderer.
 *
 * This document is the strip above the page: tabs, the omnibox, the find bar,
 * notices and the progress bar. Its combined height is reported to the main
 * process, which keeps the page surface exactly below it.
 *
 * Two things deliberately do NOT live here:
 *   - the side panel, which is its own WebContentsView (see panel.js), because
 *     Chromium does not rasterise chrome pixels in a region a page view covers;
 *   - failed loads, which load Verity's error document into the tab itself.
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

const $ = (id) => document.getElementById(id);

/** Tiny hyperscript: `h('div', {class:'x'}, child, 'text')`. */
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    // `html` is only ever used with static ICONS markup.
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

const state = {
  tabs: [],
  activeId: null,
  settings: null,
  bookmarks: [],
  panel: { open: false, view: null },
  omniboxDirty: false,
  dragId: null,
  findMatches: 0,
  findActive: 0,
  noticeTimer: null,
  hintTimer: null,
};

function activeTab() {
  return state.tabs.find((tab) => tab.id === state.activeId) || null;
}

/** The address the user should see: the failed one, if the tab is showing an error. */
function displayUrl(tab) {
  if (!tab) return '';
  return tab.error && tab.error.url ? tab.error.url : tab.url;
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

// ------------------------------------------------------------------- boot

async function init() {
  document.documentElement.dataset.platform = api.platform;
  wireStaticControls();
  observeChromeHeight();

  const [settingsResult, bookmarkResult] = await Promise.all([api.settings.get(), api.bookmarks.list()]);
  if (settingsResult.ok) state.settings = settingsResult.settings;
  if (bookmarkResult.ok) state.bookmarks = bookmarkResult.bookmarks || [];
  applyTheme();
  renderBookmarksBar();

  api.on(handleEvent);
  render();
  focusOmnibox();
}

function wireStaticControls() {
  // New tab: the plus stays, because a plus is how everyone reads "new tab".
  $('new-tab').innerHTML = ICONS.plus;
  $('new-tab').addEventListener('click', () => api.tabs.create({}));

  // The mascot, at the head of the strip. Original art: the Verity character
  // belongs to its own creators and is not ours to ship. See icons.js.
  if ($('brand') && globalThis.verityMark) $('brand').innerHTML = globalThis.verityMark({ size: 20 });

  for (const id of ['nav-back', 'nav-forward', 'nav-home']) {
    $(id).innerHTML = ICONS[$(id).dataset.command];
    $(id).addEventListener('click', () => api.nav.command($(id).dataset.command));
  }
  $('nav-reload').innerHTML = ICONS.reload;
  $('nav-reload').addEventListener('click', () => {
    const tab = activeTab();
    api.nav.command(tab && tab.loading ? 'stop' : 'reload');
  });

  $('star').innerHTML = ICONS.star;
  $('star').addEventListener('click', toggleBookmark);

  $('menu-btn').innerHTML = ICONS.menu;
  $('menu-btn').addEventListener('click', () => togglePanel('menu'));
  $('shield-glyph').innerHTML = ICONS.shield;
  $('shield-btn').addEventListener('click', () => togglePanel('shield'));
  $('security-chip').innerHTML = ICONS.globe;
  $('security-chip').addEventListener('click', () => togglePanel('shield'));

  const form = $('omnibox-form');
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submitOmnibox();
  });

  const input = $('url-input');
  input.addEventListener('focus', () => {
    state.omniboxDirty = false;
    input.select();
  });
  input.addEventListener('input', () => {
    state.omniboxDirty = true;
    scheduleHint(input.value);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      state.omniboxDirty = false;
      hideHint();
      input.value = displayUrl(activeTab());
      input.blur();
      api.panels.hide();
    }
  });
  input.addEventListener('blur', () => {
    state.omniboxDirty = false;
    hideHint();
    input.value = displayUrl(activeTab());
  });

  $('find-prev').innerHTML = ICONS.up;
  $('find-next').innerHTML = ICONS.down;
  $('find-close').innerHTML = ICONS.close;
  $('find-close').addEventListener('click', closeFind);
  $('find-prev').addEventListener('click', () => stepFind(false));
  $('find-next').addEventListener('click', () => stepFind(true));
  const findInput = $('find-input');
  findInput.addEventListener('input', () => api.nav.find(findInput.value, { forward: true, findNext: false }));
  findInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeFind();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      stepFind(!event.shiftKey);
    }
  });

  $('notice-close').addEventListener('click', hideNotice);
}

function togglePanel(view) {
  if (state.panel.open && state.panel.view === view) {
    api.panels.hide();
    return;
  }
  api.panels.show(view);
}

// ---------------------------------------------------- chrome height sync

/**
 * The strip's measured height tells main where the page surface starts.
 *
 * A ResizeObserver only delivers with a rendered frame, so a window the compositor
 * is not drawing would leave main with a stale height — and a stale height lays the
 * page surface out against the wrong offset. Every place that shows or hides a bar
 * therefore measures directly, main can ask with "measure-chrome", and the observer
 * stays as a backstop for purely CSS-driven changes. Duplicate reports are free:
 * an unchanged height is dropped here.
 */
let syncChromeHeight = () => {};

function observeChromeHeight() {
  const chrome = $('chrome');
  let last = 0;
  syncChromeHeight = () => {
    const height = Math.round(chrome.getBoundingClientRect().height);
    if (height === last) return;
    last = height;
    document.documentElement.style.setProperty('--chrome-h', `${height}px`);
    api.ui.setChromeHeight(height);
  };
  new ResizeObserver(syncChromeHeight).observe(chrome);
  syncChromeHeight();
}

// ----------------------------------------------------------------- events

function handleEvent(payload) {
  if (!payload || !payload.type) return;
  switch (payload.type) {
    case 'tabs-updated':
      state.tabs = payload.state.tabs || [];
      state.activeId = payload.state.activeId;
      render();
      break;
    case 'active-tab-changed':
      renderToolbar();
      break;
    case 'panel-state':
      state.panel = { open: Boolean(payload.open), view: payload.panel || null };
      renderShield(activeTab());
      break;
    case 'privacy-summary':
    case 'privacy-tab-report':
      renderShield(activeTab());
      break;
    case 'blocked-request': {
      const tab = activeTab();
      if (tab && typeof payload.count === 'number') tab.blocked = payload.count;
      renderShield(tab);
      pulseShield();
      break;
    }
    case 'focus-omnibox':
      focusOmnibox();
      break;
    case 'open-find':
      openFind();
      break;
    case 'notice':
      showNotice(payload.text, payload.level);
      break;
    case 'target-url':
      peekUrl(payload.url);
      break;
    case 'find-result':
      state.findMatches = payload.matches || 0;
      state.findActive = payload.active || 0;
      renderFindCount();
      break;
    case 'load-failed':
      showNotice(`Could not load ${hostOf(payload.error && payload.error.url)}: ${payload.error && payload.error.description}.`, 'error');
      renderToolbar();
      break;
    case 'settings-changed':
      state.settings = payload.settings;
      applyTheme();
      renderBookmarksBar();
      break;
    case 'measure-chrome':
      syncChromeHeight();
      break;
    default:
      break;
  }
}

// -------------------------------------------------------------- rendering

function render() {
  renderTabs();
  renderToolbar();
}

function renderTabs() {
  const strip = $('tabstrip');
  strip.textContent = '';
  for (const tab of state.tabs) {
    const favicon = h('span', { class: 'favicon' });
    if (tab.loading) {
      favicon.classList.add('loading');
      favicon.innerHTML = ICONS.spinner;
    } else if (tab.favicon) {
      const img = h('img', { src: tab.favicon, alt: '' });
      img.addEventListener('error', () => {
        img.remove();
        favicon.innerHTML = tab.isPrivate ? ICONS.incognito : ICONS.globe;
      });
      favicon.append(img);
    } else {
      favicon.innerHTML = tab.isPrivate ? ICONS.incognito : ICONS.globe;
    }

    const close = h('button', {
      class: 'tab-close',
      type: 'button',
      'aria-label': 'Close tab',
      html: ICONS.close,
      onclick: (event) => {
        event.stopPropagation();
        api.tabs.close(tab.id);
      },
    });

    const node = h(
      'div',
      {
        class: `tab${tab.id === state.activeId ? ' active' : ''}${tab.isPrivate ? ' private' : ''}`,
        role: 'tab',
        draggable: 'true',
        title: `${tab.title}\n${displayUrl(tab)}`,
        'aria-selected': tab.id === state.activeId ? 'true' : 'false',
        onclick: () => api.tabs.activate(tab.id),
        onauxclick: (event) => {
          if (event.button === 1) api.tabs.close(tab.id);
        },
        ondragstart: (event) => {
          state.dragId = tab.id;
          event.dataTransfer.setData('text/plain', String(tab.id));
          event.dataTransfer.effectAllowed = 'move';
          node.classList.add('dragging');
        },
        ondragend: () => {
          state.dragId = null;
          clearDropMarkers();
          node.classList.remove('dragging');
        },
        ondragover: (event) => {
          if (state.dragId === null || state.dragId === tab.id) return;
          event.preventDefault();
          markDropTarget(tab.id, event);
        },
        ondrop: (event) => {
          if (state.dragId === null) return;
          event.preventDefault();
          const index = state.tabs.findIndex((candidate) => candidate.id === tab.id);
          const before = isBeforeMidpoint(event, node);
          api.tabs.move(state.dragId, before ? index : index + 1);
          state.dragId = null;
          clearDropMarkers();
        },
      },
      favicon,
      h('span', { class: 'tab-title', text: tab.title || displayUrl(tab) || 'New tab' }),
      close
    );
    strip.append(node);
  }

  const active = strip.querySelector('.tab.active');
  if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function renderToolbar() {
  const tab = activeTab();
  const url = displayUrl(tab);

  $('nav-back').disabled = !(tab && tab.canGoBack);
  $('nav-forward').disabled = !(tab && tab.canGoForward);

  const reload = $('nav-reload');
  reload.innerHTML = tab && tab.loading ? ICONS.stop : ICONS.reload;
  reload.title = tab && tab.loading ? 'Stop (Ctrl+.)' : 'Reload (Ctrl+R)';

  $('progress').hidden = !(tab && tab.loading);

  const input = $('url-input');
  if (!state.omniboxDirty) input.value = url;

  renderSecurityChip(tab);
  renderShield(tab);
  renderStar(url);
}

function renderSecurityChip(tab) {
  const chip = $('security-chip');
  const url = displayUrl(tab);
  let kind = 'unknown';
  let label = 'Verity cannot read this address';
  let icon = ICONS.globe;

  if (tab && tab.error) {
    kind = 'insecure';
    label = `This page failed to load: ${tab.error.description}`;
    icon = ICONS.warn;
  } else if (url.startsWith('verity:')) {
    kind = 'internal';
    label = 'A Verity page, served from this app';
    icon = ICONS.shieldCheck;
  } else if (url.startsWith('https:')) {
    kind = 'secure';
    label = 'Encrypted connection (HTTPS)';
    icon = ICONS.lock;
  } else if (url.startsWith('http:')) {
    kind = 'insecure';
    label = 'Not secure — this connection is sent in the clear';
    icon = ICONS.warn;
  }

  chip.className = `chip ${kind}`;
  chip.innerHTML = icon;
  chip.title = label;
}

function renderShield(tab) {
  const count = tab ? tab.blocked || 0 : 0;
  const button = $('shield-btn');
  button.classList.toggle('clean', count === 0);
  button.classList.toggle('guarding', count > 0);
  button.classList.toggle('open', state.panel.open && state.panel.view === 'shield');
  $('shield-glyph').innerHTML = count > 0 ? ICONS.shieldCheck : ICONS.shield;
  $('shield-count').textContent = String(count);
  button.title = count
    ? `${count} tracker${count === 1 ? '' : 's'} blocked on this page`
    : 'Shield — nothing blocked on this page yet';
}

function pulseShield() {
  const button = $('shield-btn');
  button.classList.remove('pulse');
  void button.offsetWidth;
  button.classList.add('pulse');
}

function renderStar(url) {
  const star = $('star');
  const saved = state.bookmarks.some((bookmark) => bookmark.url === url);
  star.innerHTML = saved ? ICONS.starOn : ICONS.star;
  star.classList.toggle('on', saved);
  star.title = saved ? 'Remove bookmark' : 'Bookmark this page';
}

function renderBookmarksBar() {
  const bar = $('bookmarks-bar');
  const show = state.settings && state.settings.showBookmarksBar;
  bar.hidden = !show;
  syncChromeHeight();
  if (!show) return;
  bar.textContent = '';
  if (!state.bookmarks.length) {
    bar.append(h('span', { class: 'empty-hint', text: 'Bookmark a page with the star in the address bar.' }));
    return;
  }
  for (const bookmark of state.bookmarks) {
    bar.append(
      h(
        'button',
        { class: 'bookmark', type: 'button', title: bookmark.url, onclick: () => api.nav.go(bookmark.url) },
        h('span', { class: 'label', text: bookmark.title || bookmark.url })
      )
    );
  }
}

async function toggleBookmark() {
  const tab = activeTab();
  if (!tab) return;
  const url = displayUrl(tab);
  if (!url) return;
  const result = await api.bookmarks.toggle(url, tab.title || url);
  if (!result.ok) return;
  state.bookmarks = result.bookmarks;
  renderStar(url);
  renderBookmarksBar();
}

// ---------------------------------------------------------------- omnibox

function focusOmnibox() {
  const input = $('url-input');
  state.omniboxDirty = false;
  input.value = displayUrl(activeTab());
  input.focus();
  input.select();
}

function submitOmnibox() {
  const input = $('url-input');
  const value = input.value.trim();
  if (!value) return;
  state.omniboxDirty = false;
  hideHint();
  api.nav.go(value);
  input.blur();
}

function scheduleHint(value) {
  clearTimeout(state.hintTimer);
  if (!value.trim()) return hideHint();
  state.hintTimer = setTimeout(async () => {
    const result = await api.nav.resolve(value);
    if (!result.ok || !state.omniboxDirty) return;
    if (result.resolved.kind === 'search') {
      setHint(`Search ${SEARCH_LABELS[(state.settings || {}).searchEngine] || 'DuckDuckGo'}`);
    } else if (result.resolved.kind === 'url') {
      setHint(hostOf(result.resolved.url) || result.resolved.url);
    } else {
      hideHint();
    }
  }, 130);
}

function setHint(text) {
  const hint = $('omnibox-hint');
  hint.textContent = text;
  hint.title = text;
}

function hideHint() {
  $('omnibox-hint').textContent = '';
}

/**
 * While the cursor is over a link the address bar shows where it leads, because a
 * status bar at the bottom of the window would be hidden by the page surface.
 */
function peekUrl(url) {
  const omnibox = $('omnibox');
  const input = $('url-input');
  if (!url) {
    omnibox.classList.remove('peek');
    input.value = displayUrl(activeTab());
    return;
  }
  omnibox.classList.add('peek');
  input.value = url;
}

// -------------------------------------------------------------------- find

function openFind() {
  const bar = $('findbar');
  bar.hidden = false;
  syncChromeHeight();
  const input = $('find-input');
  input.focus();
  input.select();
}

function closeFind() {
  $('findbar').hidden = true;
  syncChromeHeight();
  api.nav.stopFind('clearSelection');
  state.findMatches = 0;
  state.findActive = 0;
  renderFindCount();
}

function stepFind(forward) {
  const input = $('find-input');
  if (!input.value) return;
  api.nav.find(input.value, { forward, findNext: true });
}

function renderFindCount() {
  $('find-count').textContent = state.findMatches ? `${state.findActive}/${state.findMatches}` : '0/0';
}

// ----------------------------------------------------------------- notices

function showNotice(text, level = 'info') {
  const bar = $('notice-bar');
  bar.hidden = false;
  bar.className = `level-${level}`;
  syncChromeHeight();
  const icon =
    { error: ICONS.warn, warning: ICONS.warn, success: ICONS.check, privacy: ICONS.shieldCheck }[level] || ICONS.info;
  $('notice-icon').innerHTML = icon;
  $('notice-text').textContent = text;
  clearTimeout(state.noticeTimer);
  state.noticeTimer = setTimeout(hideNotice, level === 'error' ? 9000 : 5500);
}

function hideNotice() {
  clearTimeout(state.noticeTimer);
  $('notice-bar').hidden = true;
  syncChromeHeight();
}

// ------------------------------------------------------------------- theme

function applyTheme() {
  document.documentElement.dataset.theme = (state.settings && state.settings.theme) || 'system';
}

// ----------------------------------------------------------- drag helpers

function isBeforeMidpoint(event, node) {
  const rect = node.getBoundingClientRect();
  return event.clientX < rect.left + rect.width / 2;
}

function markDropTarget(tabId, event) {
  clearDropMarkers();
  const nodes = [...$('tabstrip').children];
  const index = state.tabs.findIndex((tab) => tab.id === tabId);
  const node = nodes[index];
  if (!node) return;
  node.classList.add(isBeforeMidpoint(event, node) ? 'drag-over-before' : 'drag-over-after');
}

function clearDropMarkers() {
  for (const node of $('tabstrip').children) {
    node.classList.remove('drag-over-before', 'drag-over-after');
  }
}

init();
