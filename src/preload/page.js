'use strict';

/**
 * Preload for Verity's own pages (verity://newtab, verity://blocked, verity://about).
 *
 * It is attached to every tab so that internal pages work no matter how a tab was
 * created, therefore the guard matters: on anything that is not a verity://
 * document it exposes nothing at all. The main process independently re-checks the
 * sender URL for every message, so a remote page that somehow reached this script
 * still cannot read stats or navigate the browser.
 */

const { contextBridge, ipcRenderer } = require('electron');

let isInternalPage = false;
try {
  isInternalPage = globalThis.location && globalThis.location.protocol === 'verity:';
} catch {
  isInternalPage = false;
}

if (isInternalPage) {
  const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload || {});

  const listeners = new Set();
  ipcRenderer.on('verity:event', (_event, payload) => {
    for (const listener of listeners) {
      try {
        listener(payload);
      } catch {
        /* a page listener must never break the bridge */
      }
    }
  });

  contextBridge.exposeInMainWorld('verityPage', {
    summary: () => invoke('verity:page:summary'),
    navigate: (input) => invoke('verity:page:navigate', { input }),
    retry: () => invoke('verity:page:retry'),
    proceedUnsafe: (url) => invoke('verity:page:proceedUnsafe', { url }),
    openPanel: (panel) => invoke('verity:page:panel', { panel }),
    on(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}
