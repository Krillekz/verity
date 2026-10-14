'use strict';

const path = require('path');
const { WebContentsView, Menu, clipboard, shell } = require('electron');

const { resolveInput } = require('./search');
const { isLocalHostname } = require('./privacy');
const { INTERNAL_PAGES } = require('./sessions');

const PAGE_PRELOAD = path.join(__dirname, '..', 'preload', 'page.js');

/** Errors we deliberately do not surface (user aborted the load). */
const IGNORED_ERROR_CODES = new Set([-3]);

/** Width of the side panel drawer. */
const PANEL_WIDTH = 380;

let nextTabId = 1;

class Tab {
  constructor({ id, view, ses, isPrivate, url }) {
    this.id = id;
    this.view = view;
    this.webContents = view.webContents;
    this.session = ses;
    this.isPrivate = isPrivate;
    this.title = 'New tab';
    this.url = url || '';
    this.favicon = '';
    this.loading = false;
    this.canGoBack = false;
    this.canGoForward = false;
    this.zoomLevel = 0;
    this.findMatches = 0;
    this.lastFindText = '';
    this.pendingFind = null;
    this.error = null;
    this.visible = false;
  }

  get webContentsId() {
    return this.webContents ? this.webContents.id : -1;
  }
}

/**
 * Owns every tab for one window.
 *
 * Each tab is a `WebContentsView` layered above the browser chrome. Only the
 * active tab is visible, and its bounds stop below the chrome strip (and to the
 * left of the side panel when one is open) so the chrome stays interactive.
 */
class TabManager {
  constructor({ win, sessionManager, settings, stats, onEvent, chromeHeight = 86 }) {
    this.win = win;
    this.sessionManager = sessionManager;
    this.settings = settings;
    this.stats = stats;
    this.onEvent = onEvent || (() => {});
    this.tabs = new Map();
    this.order = [];
    this.activeId = null;
    this.closedStack = [];
    this.chromeHeight = chromeHeight;
    this.fullscreen = false;
    this.destroyed = false;
    /** The side panel is its own WebContentsView, raised above the page. */
    this.panelView = null;
    this.panelName = null;

    this._onResize = () => this.layout();
    this._onEnterFullscreen = () => {
      this.fullscreen = true;
      this.layout();
    };
    this._onLeaveFullscreen = () => {
      this.fullscreen = false;
      this.layout();
    };
    win.on('resize', this._onResize);
    win.on('enter-full-screen', this._onEnterFullscreen);
    win.on('leave-full-screen', this._onLeaveFullscreen);
    win.on('closed', () => this.destroy());
  }

  // ------------------------------------------------------------- lifecycle

  /** @returns {Tab} */
  create({ url, background = false, index = -1, ses } = {}) {
    if (this.destroyed) throw new Error('TabManager destroyed');
    const session = ses || this.sessionManager.forWindow(this.win.id);
    const isPrivate = this.sessionManager.isEphemeral(session);

    const view = new WebContentsView({
      webPreferences: {
        session,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        safeDialogs: true,
        spellcheck: true,
        backgroundThrottling: true,
        enableWebSQL: false,
        navigateOnDragDrop: false,
        autoplayPolicy: 'document-user-activation-required',
        // The page preload self-disables on anything that is not a verity://
        // document, and every IPC handler re-checks the sender URL in main.
        preload: PAGE_PRELOAD,
      },
    });
    if (typeof view.setBackgroundColor === 'function') view.setBackgroundColor('#0a0a0c');

    const tab = new Tab({ id: nextTabId++, view, ses: session, isPrivate, url });
    this.tabs.set(tab.id, tab);

    if (index >= 0 && index < this.order.length) this.order.splice(index, 0, tab.id);
    else this.order.push(tab.id);

    this.addTabView(view);

    this.wireTab(tab);
    this.applyZoom(tab);

    const target = url || this.settings.get('homepage') || 'verity://newtab';
    this.load(tab, target);

    if (!background || this.activeId === null) this.activate(tab.id);
    else this.emitState();

    return tab;
  }

  wireTab(tab) {
    const wc = tab.webContents;

    wc.on('page-title-updated', (_e, title) => {
      tab.title = title || tab.url;
      this.emitState();
    });

    wc.on('page-favicon-updated', (_e, favicons) => {
      tab.favicon = pickFavicon(favicons, tab.url);
      this.emitState();
    });

    wc.on('did-start-loading', () => {
      tab.loading = true;
      this.emitState();
    });

    wc.on('did-stop-loading', () => {
      tab.loading = false;
      this.refreshNavigationState(tab);
      this.emitState();
    });

    wc.on('did-start-navigation', (details) => {
      if (!details.isMainFrame) return;
      // Loading Verity's own error document must not erase the failure that
      // caused it, so the address bar keeps showing the address that failed.
      const isErrorDocument = details.url.startsWith('verity://blocked');
      if (!isErrorDocument) tab.error = null;
      // A fresh document starts with a fresh block tally.
      this.stats.clear(wc.id);
      tab.url = isErrorDocument && tab.error ? tab.error.url : details.url;
      this.emitState();
    });

    wc.on('did-navigate', (_e, url) => {
      if (!(url.startsWith('verity://blocked') && tab.error)) {
        tab.error = null;
        tab.url = url;
      }
      this.refreshNavigationState(tab);
      this.emitState();
    });

    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame) return;
      tab.url = url;
      this.refreshNavigationState(tab);
      this.emitState();
    });

    wc.on('did-finish-load', () => {
      this.refreshNavigationState(tab);
      this.emitState();
    });

    wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || IGNORED_ERROR_CODES.has(errorCode)) return;
      tab.loading = false;
      tab.error = { code: errorCode, description: errorDescription, url: validatedURL || tab.url };
      this.showErrorDocument(tab);
      this.onEvent({ type: 'load-failed', tabId: tab.id, error: tab.error });
      this.emitState();
    });

    wc.on('found-in-page', (_e, result) => {
      if (tab.pendingFind && tab.pendingFind.requestId === result.requestId) {
        clearTimeout(tab.pendingFind.timer);
        tab.pendingFind = null;
      }
      tab.findMatches = result.matches || 0;
      this.onEvent({
        type: 'find-result',
        tabId: tab.id,
        matches: result.matches || 0,
        active: result.activeMatchOrdinal || 0,
      });
    });

    wc.on('update-target-url', (_e, url) => {
      if (this.activeId !== tab.id) return;
      this.onEvent({ type: 'target-url', url });
    });

    wc.on('render-process-gone', (_e, details) => {
      this.onEvent({
        type: 'notice',
        level: 'error',
        text: `Page crashed (${details.reason}) — reload to try again.`,
      });
    });

    wc.on('unresponsive', () => {
      this.onEvent({ type: 'notice', level: 'warning', text: 'Page is not responding.' });
    });

    wc.on('enter-html-full-screen', () => {
      this.fullscreen = true;
      this.layout();
    });
    wc.on('leave-html-full-screen', () => {
      this.fullscreen = false;
      this.layout();
    });

    wc.on('zoom-changed', (_e, direction) => {
      if (this.activeId === tab.id) this.zoom(direction === 'in' ? 1 : -1);
    });

    wc.on('context-menu', (_e, params) => this.showContextMenu(tab, params));

    // Never let a site attach a <webview>.
    wc.on('will-attach-webview', (event) => event.preventDefault());

    // Popups become tabs; only real web URLs are allowed through.
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url) || url.startsWith('verity:')) {
        this.create({ url });
      } else {
        this.onEvent({
          type: 'notice',
          level: 'privacy',
          text: 'Blocked a popup from opening a non-web address.',
        });
      }
      return { action: 'deny' };
    });
  }

  close(id) {
    const tab = this.tabs.get(id);
    if (!tab) return false;
    const index = this.order.indexOf(id);

    if (tab.url && !tab.url.startsWith('verity://blocked')) {
      this.closedStack.push({ url: tab.url, title: tab.title, isPrivate: tab.isPrivate });
      if (this.closedStack.length > 25) this.closedStack.shift();
    }

    this.cancelPendingFind(tab);
    this.tabs.delete(id);
    this.order = this.order.filter((tabId) => tabId !== id);
    this.stats.clear(tab.webContentsId);

    try {
      this.win.contentView.removeChildView(tab.view);
    } catch {
      /* already detached */
    }
    try {
      tab.webContents.close();
    } catch {
      /* already gone */
    }

    if (this.activeId === id) {
      this.activeId = null;
      const next = this.order[Math.min(index, this.order.length - 1)];
      if (next !== undefined) this.activate(next);
      else this.onEvent({ type: 'all-tabs-closed' });
    } else {
      this.emitState();
    }
    return true;
  }

  activate(id) {
    const tab = this.tabs.get(id);
    if (!tab) return false;
    if (this.activeId === id) {
      this.emitState();
      return true;
    }
    const previous = this.tabs.get(this.activeId);
    if (previous) {
      previous.view.setVisible(false);
      previous.visible = false;
    }
    this.activeId = id;
    tab.view.setVisible(true);
    tab.visible = true;
    this.layout();
    try {
      tab.webContents.focus();
    } catch {
      /* not focusable yet */
    }
    this.emitState();
    this.onEvent({ type: 'active-tab-changed', tabId: id, tab: this.serializeTab(tab) });
    return true;
  }

  activateIndex(index) {
    const id = this.order[index];
    if (id !== undefined) this.activate(id);
    return id;
  }

  activateRelative(delta) {
    if (this.order.length === 0) return;
    const current = this.order.indexOf(this.activeId);
    const next = (current + delta + this.order.length) % this.order.length;
    this.activateIndex(next);
  }

  moveTab(id, toIndex) {
    const from = this.order.indexOf(id);
    if (from === -1) return false;
    const target = Math.max(0, Math.min(this.order.length - 1, toIndex));
    if (from === target) return false;
    this.order.splice(from, 1);
    this.order.splice(target, 0, id);
    this.emitState();
    return true;
  }

  reopenClosed() {
    const entry = this.closedStack.pop();
    if (!entry) return null;
    return this.create({ url: entry.url });
  }

  active() {
    return this.tabs.get(this.activeId) || null;
  }

  all() {
    return this.order.map((id) => this.tabs.get(id)).filter(Boolean);
  }

  // ------------------------------------------------------------ navigation

  load(tab, url) {
    const target = url || this.settings.get('homepage');
    tab.url = target;
    tab.error = null;
    tab.webContents.loadURL(target).catch((err) => {
      // SSL/connection failures also arrive via did-fail-load; ignore the dupe.
      if (!/ERR_ABORTED/.test(err.message)) {
        tab.error = { code: 0, description: err.message, url: target };
        this.emitState();
      }
    });
  }

  /** Omnibox-style navigation: resolves URLs, hosts and search terms. */
  navigate(input, { tab } = {}) {
    const target = tab || this.active();
    if (!target) return null;
    const resolved = resolveInput(input, this.settings.get('searchEngine'), this.settings.get('homepage'));
    // Never let the omnibox be used to smuggle in a privileged scheme.
    if (!isAllowedNavigation(resolved.url)) {
      this.onEvent({ type: 'notice', level: 'error', text: 'Verity will not open that kind of address.' });
      return null;
    }
    this.load(target, resolved.url);
    this.emitState();
    return resolved;
  }

  back(tab) {
    const target = tab || this.active();
    if (!target) return;
    const history = target.webContents.navigationHistory;
    if (history && history.canGoBack()) history.goBack();
    else target.webContents.goBack && target.webContents.goBack();
  }

  forward(tab) {
    const target = tab || this.active();
    if (!target) return;
    const history = target.webContents.navigationHistory;
    if (history && history.canGoForward()) history.goForward();
    else target.webContents.goForward && target.webContents.goForward();
  }

  reload({ ignoreCache = false, tab } = {}) {
    const target = tab || this.active();
    if (!target) return;
    if (ignoreCache) target.webContents.reloadIgnoringCache();
    else target.webContents.reload();
  }

  stop() {
    const target = this.active();
    if (target) target.webContents.stop();
  }

  home() {
    const target = this.active();
    if (target) this.load(target, this.settings.get('homepage'));
  }

  /**
   * Fall back to plain HTTP for one host after an HTTPS-only failure.
   * This is an explicit, per-site, user-initiated exception.
   */
  proceedUnsafe(url) {
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      return false;
    }
    if (!host || isLocalHostname(host)) return false;
    this.settings.setSiteException(host, { httpsOnly: false });
    const target = this.active();
    if (target) this.load(target, url.replace(/^https:/i, 'http:'));
    this.onEvent({ type: 'notice', level: 'warning', text: `HTTPS-only disabled for ${host}.` });
    return true;
  }

  // ------------------------------------------------------------------ misc

  refreshNavigationState(tab) {
    const history = tab.webContents.navigationHistory;
    if (history && typeof history.canGoBack === 'function') {
      tab.canGoBack = history.canGoBack();
      tab.canGoForward = history.canGoForward();
    } else {
      tab.canGoBack = Boolean(tab.webContents.canGoBack && tab.webContents.canGoBack());
      tab.canGoForward = Boolean(tab.webContents.canGoForward && tab.webContents.canGoForward());
    }
  }

  applyZoom(tab) {
    try {
      tab.webContents.setZoomLevel(tab.zoomLevel);
    } catch {
      /* zoom before first load can throw */
    }
  }

  zoom(delta) {
    const tab = this.active();
    if (!tab) return 0;
    tab.zoomLevel = Math.max(-3, Math.min(5, tab.zoomLevel + delta));
    this.applyZoom(tab);
    this.emitState();
    this.onEvent({ type: 'notice', level: 'info', text: `Zoom ${Math.round(Math.pow(1.2, tab.zoomLevel) * 100)}%` });
    return tab.zoomLevel;
  }

  resetZoom() {
    const tab = this.active();
    if (!tab) return 0;
    tab.zoomLevel = 0;
    this.applyZoom(tab);
    this.emitState();
    return 0;
  }

  /**
   * Start (or advance) a find-in-page search on the active tab.
   *
   * Chromium can silently drop the first request for a document that has only
   * just become active — observed with WebContentsView tabs, and the reason
   * Ctrl+F occasionally appeared to do nothing. A new search is therefore
   * re-issued once if no `found-in-page` result comes back; follow-up requests
   * are never retried, since they carry the user's intent to move on.
   */
  find(text, { forward = true, findNext = false } = {}) {
    const tab = this.active();
    if (!tab) return 0;
    if (!text) {
      this.cancelPendingFind(tab);
      tab.webContents.stopFindInPage('clearSelection');
      tab.findMatches = 0;
      this.onEvent({ type: 'find-result', tabId: tab.id, matches: 0, active: 0 });
      return 0;
    }
    tab.lastFindText = text;
    this.issueFind(tab, text, { forward, findNext });
    return tab.findMatches;
  }

  issueFind(tab, text, { forward, findNext, isRetry = false }) {
    this.cancelPendingFind(tab);
    let requestId = null;
    try {
      requestId = tab.webContents.findInPage(text, { forward, findNext });
    } catch {
      return;
    }
    if (findNext || isRetry) return;
    const timer = setTimeout(() => {
      if (!tab.pendingFind || tab.pendingFind.requestId !== requestId) return;
      tab.pendingFind = null;
      this.issueFind(tab, text, { forward, findNext: false, isRetry: true });
    }, 400);
    tab.pendingFind = { requestId, text, timer };
  }

  cancelPendingFind(tab) {
    if (tab.pendingFind) {
      clearTimeout(tab.pendingFind.timer);
      tab.pendingFind = null;
    }
  }

  stopFind(action = 'clearSelection') {
    const tab = this.active();
    if (!tab) return;
    this.cancelPendingFind(tab);
    tab.webContents.stopFindInPage(action);
  }

  toggleDevTools() {
    const tab = this.active();
    if (!tab) return;
    if (tab.webContents.isDevToolsOpened()) tab.webContents.closeDevTools();
    else tab.webContents.openDevTools({ mode: 'detach' });
  }

  showContextMenu(tab, params) {
    const template = [];
    const history = tab.webContents.navigationHistory;
    const canBack = history ? history.canGoBack() : false;
    const canForward = history ? history.canGoForward() : false;

    if (params.linkURL) {
      template.push(
        { label: 'Open Link in New Tab', click: () => this.create({ url: params.linkURL }) },
        { label: 'Open Link in Background Tab', click: () => this.create({ url: params.linkURL, background: true }) },
        { type: 'separator' },
        { label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) },
        { type: 'separator' }
      );
    }
    if (params.srcURL && params.mediaType === 'image') {
      template.push(
        { label: 'Open Image in New Tab', click: () => this.create({ url: params.srcURL }) },
        { label: 'Copy Image Address', click: () => clipboard.writeText(params.srcURL) },
        { type: 'separator' }
      );
    }
    if (params.selectionText) {
      template.push(
        { label: 'Copy', role: 'copy' },
        {
          label: `Search for "${truncate(params.selectionText, 24)}"`,
          click: () => this.create({ url: this.searchFor(params.selectionText) }),
        },
        { type: 'separator' }
      );
    }
    if (params.isEditable) {
      template.push(
        { label: 'Cut', role: 'cut' },
        { label: 'Copy', role: 'copy' },
        { label: 'Paste', role: 'paste' },
        { label: 'Select All', role: 'selectAll' },
        { type: 'separator' }
      );
    }

    template.push(
      { label: 'Back', enabled: canBack, click: () => this.back(tab) },
      { label: 'Forward', enabled: canForward, click: () => this.forward(tab) },
      { label: 'Reload', click: () => this.reload({ tab }) },
      { type: 'separator' },
      {
        label: hostLabel(params.pageURL) ? `Shield settings for ${hostLabel(params.pageURL)}` : 'Shield settings',
        click: () => this.onEvent({ type: 'open-panel', panel: 'shield' }),
      },
      {
        label: 'Privacy report for this page',
        click: () => this.onEvent({ type: 'open-panel', panel: 'shield' }),
      },
      { type: 'separator' },
      { label: 'Open in Default Browser', click: () => params.linkURL && shell.openExternal(params.linkURL) },
      { label: 'Inspect Element', click: () => tab.webContents.inspectElement(params.x, params.y) }
    );

    Menu.buildFromTemplate(template).popup({ window: this.win });
  }

  searchFor(text) {
    return resolveInput(text, this.settings.get('searchEngine'), this.settings.get('homepage')).url;
  }

  // ---------------------------------------------------------------- layout

  /**
   * Replace a failed page with Verity's own error document.
   *
   * The error page is a real document in the tab rather than an overlay drawn by
   * the chrome renderer: the chrome document is composited under the page views
   * and Chromium will not rasterise it in a region a view has covered, which left
   * overlay pixels blank. `tab.error` survives so the address bar keeps showing
   * the address that failed and the page can offer a retry.
   */
  showErrorDocument(tab) {
    if (!tab.error) return;
    const failedUrl = tab.error.url || tab.url || '';
    const description = String(tab.error.description || '');
    const looksLikeTls = /^https:/i.test(failedUrl) && /SSL|CERT|PRIVACY|TLS|HANDSHAKE|CONNECTION_REFUSED|CONNECTION_CLOSED|CONNECTION_RESET/i.test(description);
    const reason = looksLikeTls ? 'tls' : 'network';
    const target =
      `verity://blocked?reason=${reason}` +
      `&url=${encodeURIComponent(failedUrl)}` +
      `&code=${encodeURIComponent(String(tab.error.code || ''))}` +
      `&detail=${encodeURIComponent(description)}`;
    tab.webContents.loadURL(target).catch(() => {
      /* window closing */
    });
  }

  /** Retry whatever the tab was trying to load. */
  retry(tab = this.active()) {
    if (!tab) return false;
    const target = tab.error ? tab.error.url : tab.url;
    if (!target) return false;
    this.load(tab, target);
    return true;
  }

  /**
   * Add a page view, keeping the side panel above it.
   *
   * Child views are stacked in insertion order, so a freshly created tab would
   * otherwise be composited over an open panel.
   */
  addTabView(view) {
    this.win.contentView.addChildView(view);
    view.setVisible(false);
    if (this.panelView) this.raisePanel();
  }

  raisePanel() {
    if (!this.panelView || !this.win || this.win.isDestroyed()) return;
    try {
      this.win.contentView.removeChildView(this.panelView);
    } catch {
      /* not attached */
    }
    this.win.contentView.addChildView(this.panelView);
  }

  // ------------------------------------------------------------ side panel

  /**
   * The side panel is a WebContentsView rather than a element of the chrome
   * document, because the chrome document is composited *under* the page views:
   * Chromium never rasterises chrome pixels in a region a view has covered, so a
   * drawer drawn there stays blank. A view renders as reliably as the page does.
   */
  ensurePanelView() {
    if (this.panelView) return this.panelView;
    const view = new WebContentsView({
      webPreferences: {
        session: this.sessionManager.forWindow(this.win.id),
        preload: require('path').join(__dirname, '..', 'preload', 'chrome.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    view.setBackgroundColor('#0a0a0c');
    this.panelView = view;
    this.win.contentView.addChildView(view);
    view.setVisible(false);
    this.positionPanel();
    return view;
  }

  /** Open the panel, replacing the already-open one if needed. */
  showPanel(name = 'shield') {
    const view = this.ensurePanelView();
    this.panelName = name;
    this.raisePanel();
    view.setVisible(true);
    this.positionPanel();
    const target = `verity://panel?view=${encodeURIComponent(name)}`;
    view.webContents.loadURL(target).catch(() => {
      /* window closing */
    });
    this.onEvent({ type: 'panel-state', open: true, panel: name });
    return true;
  }

  hidePanel() {
    if (!this.panelView) return false;
    this.panelView.setVisible(false);
    this.panelName = null;
    this.onEvent({ type: 'panel-state', open: false, panel: null });
    return true;
  }

  /** Width the panel currently occupies; 0 when it is closed. */
  get panelWidth() {
    if (!this.panelView) return 0;
    return this.panelView.getVisible() ? PANEL_WIDTH : 0;
  }

  positionPanel() {
    if (!this.panelView || !this.win || this.win.isDestroyed()) return;
    const [width, height] = this.win.getContentSize();
    const top = this.fullscreen ? 0 : this.chromeHeight;
    const panelWidth = Math.min(PANEL_WIDTH, Math.max(240, width - 240));
    try {
      this.panelView.setBounds({ x: width - panelWidth, y: top, width: panelWidth, height: Math.max(0, height - top) });
    } catch {
      /* view detached */
    }
  }

  /** Height of the chrome strip, reported by the renderer once measured. */
  setChromeHeight(height) {
    const next = Math.max(0, Math.min(400, Math.round(Number(height) || 0)));
    if (next === this.chromeHeight) return;
    this.chromeHeight = next;
    this.layout();
  }

  layout() {
    if (this.destroyed || !this.win || this.win.isDestroyed()) return;
    const [width, height] = this.win.getContentSize();
    const top = this.fullscreen ? 0 : this.chromeHeight;
    // The panel floats above the page, so the page always keeps the full width.
    const bounds = {
      x: 0,
      y: top,
      width,
      height: Math.max(0, height - top),
    };
    this.positionPanel();
    for (const tab of this.tabs.values()) {
      try {
        tab.view.setBounds(bounds);
      } catch {
        /* view detached during teardown */
      }
    }
  }

  // --------------------------------------------------------------- reports

  serializeTab(tab) {
    return {
      id: tab.id,
      title: tab.title || tab.url || 'New tab',
      url: tab.url,
      favicon: tab.favicon,
      loading: tab.loading,
      canGoBack: tab.canGoBack,
      canGoForward: tab.canGoForward,
      isPrivate: tab.isPrivate,
      audible: false,
      zoomLevel: tab.zoomLevel,
      blocked: this.stats.get(tab.webContentsId).count,
      error: tab.error,
    };
  }

  serialize() {
    return {
      tabs: this.order.map((id) => this.serializeTab(this.tabs.get(id))).filter(Boolean),
      activeId: this.activeId,
    };
  }

  emitState() {
    this.onEvent({ type: 'tabs-updated', state: this.serialize() });
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    try {
      this.win.removeListener('resize', this._onResize);
      this.win.removeListener('enter-full-screen', this._onEnterFullscreen);
      this.win.removeListener('leave-full-screen', this._onLeaveFullscreen);
    } catch {
      /* window already gone */
    }
    for (const tab of this.tabs.values()) {
      try {
        tab.webContents.close();
      } catch {
        /* ignore */
      }
    }
    if (this.panelView) {
      try {
        this.win.contentView.removeChildView(this.panelView);
        this.panelView.webContents.close();
      } catch {
        /* window already gone */
      }
      this.panelView = null;
    }
    this.tabs.clear();
    this.order = [];
    this.activeId = null;
  }
}

const INTERNAL_HOSTS = new Set([...Object.keys(INTERNAL_PAGES), 'blocked']);

/** Only schemes a web browser should ever navigate the omnibox to. */
function isAllowedNavigation(url) {
  return /^(https?:|verity:|about:blank$|file:)/i.test(String(url || ''));
}

function hostLabel(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function truncate(text, max) {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * Two hosts belong to the same site when one is the other or a subdomain of it.
 * Deliberately looser than registrable-domain matching so that a CDN subdomain
 * still counts, and deliberately not a public-suffix implementation so that
 * nothing here has to be kept in step with the PSL.
 */
function sameSiteHost(a, b) {
  const left = String(a || '').toLowerCase();
  const right = String(b || '').toLowerCase();
  if (!left || !right) return false;
  return left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`);
}

/**
 * Choose which declared favicon Verity is willing to paint.
 *
 * The chrome strip renders these URLs, so an icon served from a third-party
 * host would turn the tab strip into a beacon that phones home for every page
 * you visit. Only icons from the page's own site (or inline data: icons) are
 * accepted; anything else falls back to the generic glyph.
 *
 * @returns {string} a usable icon URL, or '' to fall back to the glyph
 */
function pickFavicon(favicons, pageUrl) {
  if (!Array.isArray(favicons)) return '';
  const pageHost = hostLabel(pageUrl);
  for (const candidate of favicons) {
    if (typeof candidate !== 'string' || !candidate) continue;
    if (candidate.startsWith('data:image/')) return candidate;
    if (!/^https?:/i.test(candidate)) continue;
    const iconHost = hostLabel(candidate);
    if (!iconHost || !pageHost) continue;
    if (sameSiteHost(iconHost, pageHost)) return candidate;
  }
  return '';
}

module.exports = {
  TabManager,
  Tab,
  isAllowedNavigation,
  INTERNAL_HOSTS,
  pickFavicon,
  sameSiteHost,
  PANEL_WIDTH,
};
