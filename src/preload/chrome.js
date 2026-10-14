'use strict';

/**
 * Preload for the browser chrome UI (verity://chrome/chrome.html).
 *
 * The chrome is the only document that gets full control of its window. The main
 * process re-validates the sender on every call, so this bridge is a convenience
 * layer, not the security boundary.
 */

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload || {});

/** Single event stream from main; the chrome switches on `type`. */
const listeners = new Set();
ipcRenderer.on('verity:event', (_event, payload) => {
  for (const listener of listeners) {
    try {
      listener(payload);
    } catch (err) {
      console.error('[verity] chrome listener failed:', err);
    }
  }
});

const api = {
  /** Subscribe to main-process events. Returns an unsubscribe function. */
  on(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  tabs: {
    create: (options) => invoke('verity:tabs:create', options),
    close: (id) => invoke('verity:tabs:close', { id }),
    activate: (id) => invoke('verity:tabs:activate', { id }),
    reopen: () => invoke('verity:tabs:reopen'),
    move: (id, index) => invoke('verity:tabs:move', { id, index }),
  },

  nav: {
    go: (input) => invoke('verity:nav:go', { input }),
    resolve: (input) => invoke('verity:nav:resolve', { input }),
    command: (name) => invoke('verity:nav:command', { name }),
    find: (text, options) => invoke('verity:nav:find', { text, ...(options || {}) }),
    stopFind: (action) => invoke('verity:nav:stopFind', { action }),
    zoom: (delta) => invoke('verity:nav:zoom', { delta }),
    proceedUnsafe: (url) => invoke('verity:nav:proceedUnsafe', { url }),
  },

  privacy: {
    report: () => invoke('verity:privacy:report'),
    setException: (host, patch) => invoke('verity:privacy:setException', { host, patch }),
    clearSite: (host) => invoke('verity:privacy:clearSite', { host }),
    clearAll: () => invoke('verity:privacy:clearAll'),
    blocklistInfo: () => invoke('verity:privacy:blocklistInfo'),
  },

  settings: {
    get: () => invoke('verity:settings:get'),
    set: (key, value) => invoke('verity:settings:set', { key, value }),
    updateFilterList: (url) => invoke('verity:settings:updateFilterList', { url }),
  },

  bookmarks: {
    list: () => invoke('verity:bookmarks:list'),
    toggle: (url, title) => invoke('verity:bookmarks:toggle', { url, title }),
    remove: (url) => invoke('verity:bookmarks:remove', { url }),
  },

  /** The side panel is its own WebContentsView, so the UI only asks for it. */
  panels: {
    show: (view) => invoke('verity:panels:show', { view }),
    hide: () => invoke('verity:panels:hide'),
  },

  ui: {
    setChromeHeight: (height) => invoke('verity:ui:setChromeHeight', { height }),
    openDevTools: () => invoke('verity:ui:devtools'),
    windowAction: (action) => invoke('verity:ui:windowAction', { action }),
    openExternal: (url) => invoke('verity:ui:openExternal', { url }),
  },

  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
};

contextBridge.exposeInMainWorld('verity', api);
