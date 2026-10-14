'use strict';

/**
 * Verity — main process.
 *
 * Responsibilities:
 *  - Privacy-oriented command line + app hardening before anything loads
 *  - One BrowserWindow per window, each with a tab manager and its own session
 *  - The verity:// internal protocol, served from src/renderer
 *  - A native menu that owns every keyboard shortcut (so shortcuts work while a
 *    page has focus, which the chrome renderer alone could never handle)
 *  - A narrow IPC surface: the chrome UI may drive the browser, verity:// pages
 *    may only read stats and ask to navigate
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  app,
  BrowserWindow,
  Menu,
  ipcMain,
  nativeTheme,
  net,
  session,
  shell,
} = require('electron');

const { Settings } = require('./settings');
const { profileArg, resolveProfilePath, profileLabel } = require('./profile');
const { Blocklist } = require('./blocklist');
const { PrivacyStats } = require('./privacy');
const { SessionManager, registerInternalScheme, RENDERER_DIR } = require('./sessions');
const { TabManager } = require('./tabs');
const { resolveInput } = require('./search');

const IS_SMOKE = process.argv.includes('--smoke');
const IS_CAPTURE = process.argv.includes('--capture');
const IS_DIAGNOSE = process.argv.includes('--diagnose');
const IS_DEV = process.argv.includes('--dev');

/** Width of the right-hand panel drawer, reported by the renderer. */
const DEFAULT_CHROME_HEIGHT = 86;

/**
 * The mascot, as the window icon.
 *
 * Generated from the same art the UI draws, by `npm run icon` (tools/make-icon.js),
 * so the face on the taskbar always matches the face in the strip.
 */
const ICON_PATH = path.join(__dirname, '..', '..', 'assets', 'icon.png');
const WINDOW_ICON = fs.existsSync(ICON_PATH) ? ICON_PATH : undefined;

registerInternalScheme();

// ---------------------------------------------------------------------------
// Command line hardening. Must run before the app is ready.
// ---------------------------------------------------------------------------

/** Chromium features that exist only to profile users or ship ads. */
const DISABLED_FEATURES = [
  'InterestCohortAPI',
  'PrivacySandboxAdsAPIs',
  'BrowsingTopics',
  'TopicsAPI',
  'Fledge',
  'FledgeBiddingAndAuctionServer',
  'AttributionReporting',
  'AttributionReportingCrossAppWeb',
  'PrivateAggregationApi',
  'Translate',
  'MediaRouter',
  'OptimizationHints',
  'AutofillServerCommunication',
];

app.commandLine.appendSwitch('disable-features', DISABLED_FEATURES.join(','));
// WebRTC is the classic "VPN leak": keep it on the public interface only.
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'default_public_interface_only');
// No hyperlink auditing pings, no domain reliability reports, no component pings.
app.commandLine.appendSwitch('no-pings');
app.commandLine.appendSwitch('disable-domain-reliability');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-breakpad');
app.commandLine.appendSwitch('disable-crash-reporter');

const TEST_MODES = { smoke: IS_SMOKE, capture: IS_CAPTURE, diagnose: IS_DIAGNOSE };
const TEST_MODE = Object.keys(TEST_MODES).find((name) => TEST_MODES[name]) || null;

/**
 * Named profiles: `--profile=work` gives an instance its own settings, bookmarks
 * and exceptions, so two copies can run side by side without sharing anything.
 * Test modes always win, so a test can never touch a profile a person made.
 */
const PROFILE_VALUE = TEST_MODE ? null : profileArg(process.argv);
const PROFILE_PATH = TEST_MODE ? null : resolveProfilePath(PROFILE_VALUE, { appDataDir: app.getPath('appData') });
const PROFILE_LABEL = profileLabel(PROFILE_VALUE, PROFILE_PATH);

if (TEST_MODE) {
  // Test runs must never touch the real profile.
  app.setPath('userData', path.join(os.tmpdir(), `verity-${TEST_MODE}-${Date.now()}`));
} else if (PROFILE_PATH) {
  app.setPath('userData', PROFILE_PATH);
  console.log(`[verity] profile "${PROFILE_LABEL}" keeps its data in ${PROFILE_PATH}`);
}
// Software compositing keeps OS-level window capture reliable, and keeps the
// headless smoke run deterministic across machines.
if (IS_SMOKE || IS_CAPTURE) app.disableHardwareAcceleration();

// ---------------------------------------------------------------------------
// Application state
// ---------------------------------------------------------------------------

const state = {
  settings: null,
  blocklist: null,
  stats: new PrivacyStats(),
  sessions: null,
  /** windowId -> { win, manager, isPrivate } */
  windows: new Map(),
};

function toChrome(entry, payload) {
  if (!entry || !entry.win || entry.win.isDestroyed()) return;
  try {
    entry.win.webContents.send('verity:event', payload);
  } catch {
    /* window tearing down */
  }
}

/**
 * The side panel is a separate document in a separate view, so it is a separate
 * delivery: an event meant for "the window" that only reaches the strip leaves
 * the drawer silently stale. Its theme and its counters are the obvious
 * casualties.
 */
function toPanel(entry, payload) {
  const panel = entry && entry.manager && entry.manager.panelView;
  if (!panel || !entry.win || entry.win.isDestroyed()) return;
  try {
    panel.webContents.send('verity:event', payload);
  } catch {
    /* panel tearing down */
  }
}

/** Every piece of browser UI a window owns: the strip and the drawer. */
function toWindowUi(entry, payload) {
  toChrome(entry, payload);
  toPanel(entry, payload);
}

function broadcast(payload) {
  for (const entry of state.windows.values()) toWindowUi(entry, payload);
}

// ---------------------------------------------------------------------------
// Window + tab wiring
// ---------------------------------------------------------------------------

function createWindow({ url, isPrivate = false, show = true } = {}) {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 560,
    minHeight: 420,
    show: false,
    icon: WINDOW_ICON,
    backgroundColor: '#0a0a0c',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    titleBarOverlay:
      process.platform === 'darwin'
        ? undefined
        : { color: '#00000000', symbolColor: '#a3a3ad', height: 36 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'chrome.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // The chrome UI is our own document; it still may not navigate.
      navigateOnDragDrop: false,
    },
  });

  const entry = { win, manager: null, isPrivate };
  state.windows.set(win.id, entry);

  // The chrome UI is served over verity:// so it gets the same CSP as our pages.
  state.sessions.attachProtocol(session.defaultSession);

  const manager = new TabManager({
    win,
    sessionManager: state.sessions,
    settings: state.settings,
    stats: state.stats,
    chromeHeight: DEFAULT_CHROME_HEIGHT,
    onEvent: (event) => handleManagerEvent(entry, event),
  });
  entry.manager = manager;

  // The chrome document must never navigate or spawn windows.
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('did-finish-load', () => {
    toChrome(entry, { type: 'settings-changed', settings: state.settings.get() });
    toChrome(entry, { type: 'tabs-updated', state: manager.serialize() });
    toChrome(entry, { type: 'privacy-summary', summary: state.stats.summary() });
  });

  win.on('closed', () => {
    state.windows.delete(win.id);
    state.sessions.releaseWindow(win.id);
  });

  win.once('ready-to-show', () => {
    if (show && !IS_SMOKE) win.show();
  });

  win.loadURL('verity://chrome/chrome.html').catch((err) => {
    // Closing a window before its first paint aborts this load; that is normal.
    if (win.isDestroyed()) return;
    console.error('[verity] chrome UI failed to load:', err.message);
  });

  manager.create({ url: url || state.settings.get('homepage') });

  return entry;
}

function handleManagerEvent(entry, event) {
  switch (event.type) {
    case 'tabs-updated': {
      toChrome(entry, event);
      const active = entry.manager.active();
      if (active) entry.win.setTitle(`${active.title || active.url} — Verity`);
      break;
    }
    case 'active-tab-changed': {
      toChrome(entry, event);
      // The shield panel draws from the same report, so it hears this too.
      toWindowUi(entry, {
        type: 'privacy-tab-report',
        report: privacyReportFor(entry),
      });
      break;
    }
    case 'load-failed': {
      toChrome(entry, { type: 'load-failed', tabId: event.tabId, error: event.error });
      break;
    }
    case 'notice': {
      toChrome(entry, { type: 'notice', level: event.level, text: event.text });
      break;
    }
    case 'open-panel': {
      focusPanel(entry);
      entry.manager.showPanel(event.panel || 'shield');
      break;
    }
    case 'all-tabs-closed': {
      entry.win.close();
      break;
    }
    default: {
      // Anything the manager reports that is not chrome-specific (blocked
      // requests, privacy summaries) is drawn by the panel as well.
      toWindowUi(entry, event);
    }
  }
}

function handleBlocked(payload) {
  for (const entry of state.windows.values()) {
    const active = entry.manager.active();
    if (active && active.webContentsId === payload.webContentsId) {
      toWindowUi(entry, {
        type: 'blocked-request',
        domain: payload.domain,
        category: payload.category,
        count: state.stats.get(payload.webContentsId).count,
      });
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the window that owns an IPC message, refusing anything else. */
function entryForChrome(event) {
  const sender = event.sender;
  const win = BrowserWindow.fromWebContents(sender);
  let entry = win ? state.windows.get(win.id) : null;
  if (!entry) {
    // A WebContentsView does not always resolve through BrowserWindow, so fall
    // back to identity: only a window's own panel view may be matched here.
    for (const candidate of state.windows.values()) {
      const panel = candidate.manager && candidate.manager.panelView;
      if (panel && panel.webContents === sender) {
        entry = candidate;
        break;
      }
    }
  }
  if (!entry) return null;
  // Exactly two Verity documents may drive a window: the chrome strip and the
  // side panel (a separate WebContentsView). A resulting sender must match both
  // the view identity and its origin, so no page can borrow either one.
  const isChrome = entry.win.webContents === sender;
  const isPanel = Boolean(
    entry.manager && entry.manager.panelView && entry.manager.panelView.webContents === sender
  );
  if (!isChrome && !isPanel) return null;
  const senderUrl = sender.getURL() || '';
  if (!senderUrl.startsWith('verity://chrome') && !senderUrl.startsWith('verity://panel')) {
    return null;
  }
  return entry;
}

/** Resolve the verity:// page (new tab, blocked page) that sent a message. */
function entryForInternalPage(event) {
  const senderUrl = event.sender.getURL() || '';
  if (!senderUrl.startsWith('verity:')) return null;
  if (senderUrl.startsWith('verity://chrome')) return null;
  for (const entry of state.windows.values()) {
    for (const tab of entry.manager.all()) {
      if (tab.webContents === event.sender) return { entry, tab };
    }
  }
  return null;
}

function privacyReportFor(entry) {
  const tab = entry.manager.active();
  const webContentsId = tab ? tab.webContentsId : -1;
  let host = '';
  try {
    host = tab && tab.url ? new URL(tab.url).hostname : '';
  } catch {
    host = '';
  }
  return {
    tabId: tab ? tab.id : null,
    url: tab ? tab.url : '',
    host,
    blocked: state.stats.get(webContentsId),
    summary: state.stats.summary(),
    filterList: state.blocklist.describe(),
    exception: host ? state.settings.siteException(host) : null,
    settings: {
      blockAdsTrackers: state.settings.get('blockAdsTrackers'),
      httpsOnly: state.settings.get('httpsOnly'),
      blockThirdPartyCookies: state.settings.get('blockThirdPartyCookies'),
      stripTrackingParams: state.settings.get('stripTrackingParams'),
      reduceFingerprinting: state.settings.get('reduceFingerprinting'),
    },
  };
}

/**
 * Give the chrome document keyboard focus. A page view normally holds focus, so
 * without this the address bar would render but not accept typing.
 */
function focusChrome(entry) {
  if (!entry || !entry.win || entry.win.isDestroyed()) return;
  try {
    entry.win.webContents.focus();
  } catch {
    /* window not ready */
  }
}

/** Focus the panel view, so its switches and fields accept input. */
function focusPanel(entry) {
  if (!entry || !entry.manager || !entry.manager.panelView) return;
  try {
    entry.manager.panelView.webContents.focus();
  } catch {
    /* panel not ready */
  }
}

/** Open the requested panel, or close it when it is already the open one. */
function togglePanel(entry, view) {
  if (entry.manager.panelName === view && entry.manager.panelWidth > 0) {
    entry.manager.hidePanel();
    focusChrome(entry);
    return;
  }
  entry.manager.showPanel(view);
  focusPanel(entry);
}

/** The window a menu command should act on. */
function commandTarget() {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && state.windows.has(focused.id)) return state.windows.get(focused.id);
  const all = [...state.windows.values()];
  return all.length ? all[all.length - 1] : null;
}

function applyCommand(entry, name, payload = {}) {
  if (!entry) return;
  const manager = entry.manager;
  switch (name) {
    case 'new-tab':
      manager.create({ url: payload.url });
      toChrome(entry, { type: 'focus-omnibox' });
      break;
    case 'new-window':
      createWindow({});
      break;
    case 'new-private-window':
      createWindow({ isPrivate: true });
      break;
    case 'close-tab': {
      const active = manager.active();
      if (active) manager.close(active.id);
      break;
    }
    case 'reopen-tab':
      manager.reopenClosed();
      break;
    case 'next-tab':
      manager.activateRelative(1);
      break;
    case 'prev-tab':
      manager.activateRelative(-1);
      break;
    case 'select-tab':
      manager.activateIndex(payload.index === 9 ? manager.order.length - 1 : payload.index - 1);
      break;
    case 'back':
      manager.back();
      break;
    case 'forward':
      manager.forward();
      break;
    case 'reload':
      manager.reload();
      break;
    case 'hard-reload':
      manager.reload({ ignoreCache: true });
      break;
    case 'stop':
      manager.stop();
      break;
    case 'home':
      manager.home();
      break;
    case 'focus-omnibox':
      focusChrome(entry);
      toChrome(entry, { type: 'focus-omnibox' });
      break;
    case 'find':
      focusChrome(entry);
      toChrome(entry, { type: 'open-find' });
      break;
    case 'find-next': {
      const tab = manager.active();
      if (tab) manager.find(tab.lastFindText, { forward: true, findNext: true });
      break;
    }
    case 'zoom-in':
      manager.zoom(1);
      break;
    case 'zoom-out':
      manager.zoom(-1);
      break;
    case 'zoom-reset':
      manager.resetZoom();
      break;
    case 'devtools':
      manager.toggleDevTools();
      break;
    case 'shield':
      togglePanel(entry, 'shield');
      break;
    case 'settings':
      togglePanel(entry, 'settings');
      break;
    case 'bookmarks':
      togglePanel(entry, 'bookmarks');
      break;
    case 'clear-data': {
      state.sessions.clear(state.sessions.forWindow(entry.win.id)).then((report) => {
        toChrome(entry, {
          type: 'notice',
          level: report.ok ? 'success' : 'warning',
          text: report.ok ? 'Browsing data cleared for this window.' : 'Some data could not be cleared.',
        });
        toChrome(entry, { type: 'privacy-summary', summary: state.stats.summary() });
        if (entry.manager.active()) entry.manager.active().webContents.reload();
      });
      break;
    }
    case 'toggle-ephemeral': {
      const next = !state.settings.get('ephemeralMode');
      state.settings.set('ephemeralMode', next);
      toChrome(entry, {
        type: 'notice',
        level: next ? 'success' : 'warning',
        text: next
          ? 'Ephemeral mode on — new windows keep nothing on disk.'
          : 'Ephemeral mode off — new windows use a persistent profile.',
      });
      break;
    }
    case 'quit':
      app.quit();
      break;
    case 'about':
      manager.create({ url: 'verity://about' });
      break;
    default:
      break;
  }

  // A command can change what the strip is made of (find bar, bookmarks bar, a
  // notice), and the page surface is laid out against the strip height. The
  // renderer's ResizeObserver only reports with a rendered frame, so ask for a
  // fresh measurement instead of waiting for one; an unchanged height is dropped.
  toChrome(entry, { type: 'measure-chrome' });
}

// ---------------------------------------------------------------------------
// Menu (owns every keyboard shortcut)
// ---------------------------------------------------------------------------

function buildMenu() {
  const cmd = (name, payload) => () => applyCommand(commandTarget(), name, payload);
  const isMac = process.platform === 'darwin';

  const template = [];

  if (isMac) {
    template.push({
      label: 'Verity',
      submenu: [
        { label: 'About Verity', click: cmd('about') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'quit' },
      ],
    });
  }

  template.push({
    label: 'File',
    submenu: [
      { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: cmd('new-tab') },
      { label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N', click: cmd('new-window') },
      { label: 'New Private Window', click: cmd('new-private-window') },
      { type: 'separator' },
      { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: cmd('close-tab') },
      { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', click: cmd('reopen-tab') },
      { type: 'separator' },
      { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', role: 'close' },
      ...(isMac ? [] : [{ role: 'quit', accelerator: 'CmdOrCtrl+Q', label: 'Quit Verity' }]),
    ],
  });

  template.push({
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
      { type: 'separator' },
      { label: 'Find in Page', accelerator: 'CmdOrCtrl+F', click: cmd('find') },
      { label: 'Find Next', accelerator: 'F3', click: cmd('find-next') },
    ],
  });

  template.push({
    label: 'View',
    submenu: [
      { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: cmd('reload') },
      { label: 'Force Reload', accelerator: 'CmdOrCtrl+Shift+R', click: cmd('hard-reload') },
      { label: 'Stop', accelerator: 'CmdOrCtrl+.', click: cmd('stop') },
      { type: 'separator' },
      { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: cmd('zoom-in') },
      { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: cmd('zoom-out') },
      { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: cmd('zoom-reset') },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      { label: 'Developer Tools', accelerator: 'CmdOrCtrl+Shift+I', click: cmd('devtools') },
    ],
  });

  template.push({
    label: 'Go',
    submenu: [
      { label: 'Back', accelerator: isMac ? 'Cmd+Left' : 'Alt+Left', click: cmd('back') },
      { label: 'Forward', accelerator: isMac ? 'Cmd+Right' : 'Alt+Right', click: cmd('forward') },
      { label: 'Home', accelerator: 'Alt+Home', click: cmd('home') },
      { type: 'separator' },
      { label: 'Focus Address Bar', accelerator: 'CmdOrCtrl+L', click: cmd('focus-omnibox') },
      { type: 'separator' },
      { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: cmd('next-tab') },
      { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: cmd('prev-tab') },
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((index) => ({
        label: index === 9 ? 'Last Tab' : `Tab ${index}`,
        accelerator: `CmdOrCtrl+${index}`,
        click: cmd('select-tab', { index }),
      })),
    ],
  });

  template.push({
    label: 'Shield',
    submenu: [
      { label: 'Shield Panel', accelerator: 'CmdOrCtrl+Shift+Y', click: cmd('shield') },
      { label: 'Bookmarks', accelerator: 'CmdOrCtrl+Shift+O', click: cmd('bookmarks') },
      { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: cmd('settings') },
      { type: 'separator' },
      {
        label: 'Clear Browsing Data for This Window',
        accelerator: 'CmdOrCtrl+Shift+Delete',
        click: cmd('clear-data'),
      },
      { label: 'Toggle Ephemeral Mode', click: cmd('toggle-ephemeral') },
      { type: 'separator' },
      { label: 'About Verity', click: cmd('about') },
    ],
  });

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// IPC — chrome UI (full control of this window only)
// ---------------------------------------------------------------------------

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, payload) => {
    const entry = entryForChrome(event);
    if (!entry) return { ok: false, error: 'unauthorized' };
    try {
      return await fn(entry, payload || {});
    } catch (err) {
      console.error(`[verity] ${channel} failed:`, err.message);
      return { ok: false, error: err.message };
    }
  });
}

function registerIpc() {
  // --- tabs -------------------------------------------------------------
  handle('verity:tabs:create', (entry, { url, background }) => {
    const tab = entry.manager.create({ url, background });
    return { ok: true, tab: entry.manager.serializeTab(tab) };
  });
  handle('verity:tabs:close', (entry, { id }) => ({ ok: entry.manager.close(id) }));
  handle('verity:tabs:activate', (entry, { id }) => ({ ok: entry.manager.activate(id) }));
  handle('verity:tabs:reopen', (entry) => ({ ok: entry.manager.reopenClosed() !== null }));
  handle('verity:tabs:move', (entry, { id, index }) => ({ ok: entry.manager.moveTab(id, index) }));

  // --- navigation -------------------------------------------------------
  handle('verity:nav:go', (entry, { input }) => {
    const before = entry.manager.active();
    const resolved = resolveInput(input, state.settings.get('searchEngine'), state.settings.get('homepage'));
    if (!/^(https?:|verity:|file:|about:blank$)/i.test(resolved.url)) {
      const tab = before;
      if (tab) {
        entry.manager.load(
          tab,
          `verity://blocked?reason=scheme&url=${encodeURIComponent(resolved.url)}`
        );
      }
      return { ok: false, resolved };
    }
    const result = entry.manager.navigate(input);
    return { ok: Boolean(result), resolved };
  });
  handle('verity:nav:resolve', (_entry, { input }) => ({
    ok: true,
    resolved: resolveInput(input, state.settings.get('searchEngine'), state.settings.get('homepage')),
  }));
  handle('verity:nav:command', (entry, { name }) => {
    applyCommand(entry, name);
    return { ok: true };
  });
  handle('verity:nav:find', (entry, { text, forward, findNext }) => ({
    ok: true,
    matches: entry.manager.find(text, { forward, findNext }),
  }));
  handle('verity:nav:stopFind', (entry, { action }) => {
    entry.manager.stopFind(action || 'clearSelection');
    return { ok: true };
  });
  handle('verity:nav:zoom', (entry, { delta }) => ({
    ok: true,
    level: delta ? entry.manager.zoom(delta) : entry.manager.resetZoom(),
  }));
  handle('verity:nav:proceedUnsafe', (entry, { url }) => ({
    ok: entry.manager.proceedUnsafe(url || (entry.manager.active() || {}).url || ''),
  }));

  // --- privacy ----------------------------------------------------------
  handle('verity:privacy:report', (entry) => ({ ok: true, report: privacyReportFor(entry) }));
  handle('verity:privacy:setException', (entry, { host, patch }) => {
    const exception = state.settings.setSiteException(host, patch || {});
    if (entry.manager.active()) entry.manager.active().webContents.reload();
    return { ok: true, exception };
  });
  handle('verity:privacy:clearSite', async (entry, { host }) => {
    const ses = state.sessions.forWindow(entry.win.id);
    await ses.clearStorageData({ origin: `https://${host}` }).catch(() => {});
    await ses.clearStorageData({ origin: `http://${host}` }).catch(() => {});
    return { ok: true };
  });
  handle('verity:privacy:clearAll', async () => {
    const report = await state.sessions.clearAll();
    broadcast({ type: 'privacy-summary', summary: state.stats.summary() });
    return { ok: report.ok, report };
  });
  handle('verity:privacy:blocklistInfo', () => ({ ok: true, info: state.blocklist.describe() }));

  // --- settings ---------------------------------------------------------
  handle('verity:settings:get', () => ({ ok: true, settings: state.settings.get() }));
  handle('verity:settings:set', (entry, { key, value }) => {
    const settings = state.settings.set(key, value);
    if (key === 'theme') nativeTheme.themeSource = settings.theme;
    return { ok: true, settings };
  });
  handle('verity:settings:updateFilterList', async (_entry, { url }) => {
    const target = String(url || state.settings.get('customBlocklistUrl') || '').trim();
    if (!/^https:\/\//i.test(target)) {
      return { ok: false, error: 'Enter an https:// URL to a hosts-format list.' };
    }
    try {
      const response = await net.fetch(target, { cache: 'no-store' });
      if (!response.ok) return { ok: false, error: `List server returned ${response.status}` };
      const text = await response.text();
      if (text.length > 5_000_000) return { ok: false, error: 'List is larger than 5 MB.' };
      const added = state.blocklist.loadCustom(text);
      state.settings.set('customBlocklistUrl', target);
      return { ok: true, added, info: state.blocklist.describe() };
    } catch (err) {
      return { ok: false, error: `Could not fetch list: ${err.message}` };
    }
  });

  // --- bookmarks --------------------------------------------------------
  handle('verity:bookmarks:list', () => ({ ok: true, bookmarks: state.settings.get('bookmarks') }));
  handle('verity:bookmarks:toggle', (_entry, { url, title }) => ({
    ok: true,
    bookmarks: state.settings.upsertBookmark({ url, title }),
  }));
  handle('verity:bookmarks:remove', (_entry, { url }) => ({
    ok: true,
    bookmarks: state.settings.removeBookmark(url),
  }));

  // --- ui ---------------------------------------------------------------
  handle('verity:ui:setChromeHeight', (entry, { height }) => {
    entry.manager.setChromeHeight(height);
    return { ok: true };
  });
  // --- side panel (its own view, so the chrome only asks for it) --------
  handle('verity:panels:show', (entry, { view }) => ({
    ok: entry.manager.showPanel(view || 'shield'),
  }));
  handle('verity:panels:hide', (entry) => ({ ok: entry.manager.hidePanel() }));
  handle('verity:ui:devtools', (entry) => {
    entry.manager.toggleDevTools();
    return { ok: true };
  });
  handle('verity:ui:windowAction', (entry, { action }) => {
    if (action === 'minimize') entry.win.minimize();
    else if (action === 'maximize') {
      if (entry.win.isMaximized()) entry.win.unmaximize();
      else entry.win.maximize();
    } else if (action === 'close') entry.win.close();
    return { ok: true, maximized: entry.win.isMaximized() };
  });
  handle('verity:ui:openExternal', (_entry, { url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { ok: true };
  });

  // --- verity:// pages (stats + navigation only) ------------------------
  const pageHandle = (channel, fn) => {
    ipcMain.handle(channel, async (event, payload) => {
      const target = entryForInternalPage(event);
      if (!target) return { ok: false, error: 'unauthorized' };
      try {
        return await fn(target.entry, target.tab, payload || {});
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });
  };

  pageHandle('verity:page:summary', () => ({
    ok: true,
    summary: state.stats.summary(),
    profile: PROFILE_LABEL,
    filterList: state.blocklist.describe(),
    versions: {
      app: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
    },
    settings: {
      searchEngine: state.settings.get('searchEngine'),
      ephemeralMode: state.settings.get('ephemeralMode'),
      blockAdsTrackers: state.settings.get('blockAdsTrackers'),
      httpsOnly: state.settings.get('httpsOnly'),
      blockThirdPartyCookies: state.settings.get('blockThirdPartyCookies'),
    },
  }));
  pageHandle('verity:page:navigate', (entry, _tab, { input }) => {
    const resolved = resolveInput(input, state.settings.get('searchEngine'), state.settings.get('homepage'));
    if (!/^(https?:|verity:)/i.test(resolved.url)) return { ok: false, error: 'refused' };
    entry.manager.navigate(input);
    return { ok: true, resolved };
  });
  pageHandle('verity:page:proceedUnsafe', (entry, _tab, { url }) => ({
    ok: entry.manager.proceedUnsafe(url),
  }));
  pageHandle('verity:page:retry', (entry) => ({
    ok: entry.manager.retry(),
  }));
  pageHandle('verity:page:panel', (entry, _tab, { panel }) => ({
    ok: entry.manager.showPanel(panel || 'shield'),
  }));
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

function bootstrap() {
  state.settings = new Settings();
  state.blocklist = new Blocklist();
  state.sessions = new SessionManager({
    settings: state.settings,
    blocklist: state.blocklist,
    stats: state.stats,
    onNotice: (notice) => broadcast({ type: 'notice', ...notice }),
    onBlocked: handleBlocked,
  });

  nativeTheme.themeSource = state.settings.get('theme');
  registerIpc();
  buildMenu();

  // Settings can change from a menu command, another window, or the panel
  // itself; every window's chrome needs to hear about it either way.
  state.settings.onChange((settings) => {
    // Internal pages have no theme attribute of their own: they follow
    // prefers-color-scheme, which Chromium takes from themeSource. Without this
    // a theme change reaches the strip but leaves the page on the old one.
    const theme = ['dark', 'light', 'system'].includes(settings.theme) ? settings.theme : 'system';
    if (nativeTheme.themeSource !== theme) nativeTheme.themeSource = theme;
    broadcast({ type: 'settings-changed', settings });
  });

  // Never accept a broken certificate, even if the user clicks through.
  app.on('certificate-error', (event, _wc, url, error, _cert, callback) => {
    event.preventDefault();
    callback(false);
    broadcast({
      type: 'notice',
      level: 'error',
      text: `Blocked an invalid certificate for ${(() => { try { return new URL(url).hostname; } catch { return url; } })()} (${error}).`,
    });
  });

  createWindow({});

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow({});
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock && !TEST_MODE) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const entry = commandTarget();
    if (entry) {
      if (entry.win.isMinimized()) entry.win.restore();
      entry.win.focus();
    }
  });

  app.whenReady().then(async () => {
    if (IS_SMOKE) {
      // Never let a broken smoke run hang: fail loudly instead.
      setTimeout(() => {
        console.error('[smoke] hard timeout — exiting');
        app.exit(3);
      }, 170000);
    }
    bootstrap();
    if (IS_SMOKE) {
      // eslint-disable-next-line global-require
      const { runSmokeTest } = require(path.join(__dirname, '..', '..', 'test', 'smoke.js'));
      const code = await runSmokeTest({ app, state, createWindow, applyCommand, privacyReportFor });
      app.exit(code);
    } else if (IS_CAPTURE) {
      // eslint-disable-next-line global-require
      const { runCapture } = require(path.join(__dirname, '..', '..', 'test', 'capture.js'));
      const code = await runCapture({ app, state, createWindow, applyCommand });
      app.exit(code);
    } else if (IS_DIAGNOSE) {
      // eslint-disable-next-line global-require
      const { runDiagnose } = require(path.join(__dirname, '..', '..', 'test', 'diagnose.js'));
      const code = await runDiagnose({ app, state, createWindow, applyCommand });
      app.exit(code);
    }
  });

  app.on('window-all-closed', () => {
    // A private browser should not linger in the background.
    app.quit();
  });

  let cleanupStarted = false;
  app.on('before-quit', (event) => {
    if (cleanupStarted) return;
    if (app.__veritySkipCleanup) return;
    cleanupStarted = true;
    event.preventDefault();
    state.sessions
      .clearOnExitIfEnabled()
      .catch(() => {})
      .finally(() => {
        app.__veritySkipCleanup = true;
        app.quit();
      });
  });
}

module.exports = { state, createWindow, applyCommand, privacyReportFor, RENDERER_DIR, IS_SMOKE, IS_CAPTURE, IS_DEV };
