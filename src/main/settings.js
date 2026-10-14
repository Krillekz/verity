'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/**
 * Search engines are ordered from most to least private. Nothing here reports
 * usage data back to Verity; the choice only affects where omnibox queries go.
 */
const SEARCH_ENGINES = Object.freeze({
  duckduckgo: {
    label: 'DuckDuckGo',
    query: 'https://duckduckgo.com/?q=%s',
    suggest: 'https://duckduckgo.com/ac/?q=%s&type=list',
  },
  startpage: {
    label: 'Startpage',
    query: 'https://www.startpage.com/sp/search?query=%s',
    suggest: null,
  },
  brave: {
    label: 'Brave Search',
    query: 'https://search.brave.com/search?q=%s',
    suggest: null,
  },
  mojeek: {
    label: 'Mojeek',
    query: 'https://www.mojeek.com/search?q=%s',
    suggest: null,
  },
  wikipedia: {
    label: 'Wikipedia',
    query: 'https://en.wikipedia.org/w/index.php?search=%s',
    suggest: null,
  },
  google: {
    label: 'Google',
    query: 'https://www.google.com/search?q=%s',
    suggest: null,
  },
});

const DEFAULTS = Object.freeze({
  // ---- General -----------------------------------------------------------
  homepage: 'verity://newtab',
  searchEngine: 'duckduckgo',

  // ---- Privacy defaults: everything protective is ON out of the box -----
  ephemeralMode: true, // browsing session is in-memory, destroyed on exit
  clearOnExit: true, // wipe storage when the last window closes
  httpsOnly: true,
  blockAdsTrackers: true,
  blockThirdPartyCookies: true,
  stripTrackingParams: true,
  reduceFingerprinting: true,
  sendDoNotTrack: true,
  denyPermissionsByDefault: true,
  blockThirdPartyStorage: true,

  // ---- Interface --------------------------------------------------------
  showBookmarksBar: false,
  // Verity's look is a bright yellow face over a very dark room, so dark is the
  // default and 'system' is the opt-in.
  theme: 'dark',

  // ---- Filter list extension -------------------------------------------
  customBlocklistUrl: '',
});

/** Keys that must be booleans; anything else from disk is coerced/dropped. */
const BOOLEAN_KEYS = Object.keys(DEFAULTS).filter((k) => typeof DEFAULTS[k] === 'boolean');

/** Browsing-adjacent data that must never be written to disk. */
const NON_PERSISTED = Object.freeze({});

class Settings {
  constructor(dir) {
    this.dir = dir || app.getPath('userData');
    this.file = path.join(this.dir, 'settings.json');
    // Run the defaults through sanitize so derived keys (siteExceptions) exist
    // even before any settings file has been written.
    this.data = this.sanitize(DEFAULTS);
    this.bookmarks = [];
    this._listeners = new Set();
    this.load();
  }

  load() {
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      raw = null; // Missing or corrupt file simply falls back to defaults.
    }
    if (raw && typeof raw === 'object') {
      this.data = this.sanitize({ ...DEFAULTS, ...raw });
      this.bookmarks = Array.isArray(raw.bookmarks) ? raw.bookmarks.filter(isBookmark).slice(0, 500) : [];
    }
  }

  /** Only known keys, with strict type coercion, survive a round trip. */
  sanitize(input) {
    const out = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) {
      const value = input[key];
      if (value === undefined) continue;
      if (BOOLEAN_KEYS.includes(key)) {
        out[key] = Boolean(value);
      } else if (key === 'searchEngine') {
        out[key] = Object.prototype.hasOwnProperty.call(SEARCH_ENGINES, value) ? value : DEFAULTS.searchEngine;
      } else if (key === 'theme') {
        out[key] = ['system', 'dark', 'light'].includes(value) ? value : DEFAULTS.theme;
      } else if (typeof DEFAULTS[key] === 'string') {
        out[key] = String(value).slice(0, 2048);
      }
    }
    // Per-site exceptions: host -> { blocking, httpsOnly, thirdPartyCookies }
    const exceptions = {};
    if (input.siteExceptions && typeof input.siteExceptions === 'object') {
      for (const [host, entry] of Object.entries(input.siteExceptions)) {
        if (typeof host !== 'string' || host.length > 255) continue;
        if (!entry || typeof entry !== 'object') continue;
        exceptions[host] = {
          blocking: entry.blocking !== false,
          httpsOnly: entry.httpsOnly !== false,
          thirdPartyCookies: entry.thirdPartyCookies !== false,
          permissions: entry.permissions === true,
        };
      }
    }
    out.siteExceptions = exceptions;
    return out;
  }

  persist() {
    const payload = JSON.stringify({ ...this.data, bookmarks: this.bookmarks }, null, 2);
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file, payload, 'utf8');
    } catch (err) {
      // A read-only profile directory must not take the browser down.
      console.error('[verity] could not persist settings:', err.message);
    }
  }

  get(key) {
    if (key === undefined) return { ...this.data, bookmarks: [...this.bookmarks] };
    if (key === 'bookmarks') return [...this.bookmarks];
    return this.data[key];
  }

  set(key, value) {
    if (key === 'bookmarks') {
      this.bookmarks = Array.isArray(value) ? value.filter(isBookmark).slice(0, 500) : [];
      this.persist();
      this.emit();
      return this.get();
    }
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) return this.get();
    const merged = this.sanitize({ ...this.data, [key]: value });
    const changed = {};
    for (const k of Object.keys(DEFAULTS)) {
      if (merged[k] !== this.data[k]) changed[k] = merged[k];
    }
    this.data = merged;
    this.persist();
    this.emit(changed);
    return this.get();
  }

  upsertBookmark(bookmark) {
    if (!isBookmark(bookmark)) return this.bookmarks;
    const clean = { url: bookmark.url, title: String(bookmark.title || bookmark.url).slice(0, 300) };
    const index = this.bookmarks.findIndex((b) => b.url === clean.url);
    if (index >= 0) this.bookmarks.splice(index, 1);
    else this.bookmarks.unshift(clean);
    this.bookmarks = this.bookmarks.slice(0, 500);
    this.persist();
    this.emit();
    return this.bookmarks;
  }

  removeBookmark(url) {
    this.bookmarks = this.bookmarks.filter((b) => b.url !== url);
    this.persist();
    this.emit();
    return this.bookmarks;
  }

  /** Per-site privacy exceptions, keyed by hostname. */
  siteException(host) {
    if (!host) return null;
    return (this.data.siteExceptions || {})[host] || null;
  }

  setSiteException(host, patch) {
    if (typeof host !== 'string' || !host) return this.get();
    if (!this.data.siteExceptions) this.data.siteExceptions = {};
    const current = this.data.siteExceptions[host] || {};
    const next = { ...current, ...patch };
    if (next.blocking !== false && next.httpsOnly !== false && next.thirdPartyCookies !== false && next.permissions !== true) {
      delete this.data.siteExceptions[host];
    } else {
      this.data.siteExceptions[host] = {
        blocking: next.blocking !== false,
        httpsOnly: next.httpsOnly !== false,
        thirdPartyCookies: next.thirdPartyCookies !== false,
        permissions: next.permissions === true,
      };
    }
    this.persist();
    this.emit();
    return this.data.siteExceptions[host] || null;
  }

  onChange(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  emit(changed) {
    const snapshot = this.get();
    for (const listener of this._listeners) {
      try {
        listener(snapshot, changed);
      } catch (err) {
        console.error('[verity] settings listener failed:', err.message);
      }
    }
  }
}

function isBookmark(value) {
  return Boolean(value) && typeof value.url === 'string' && /^[a-z][a-z0-9+.-]*:/i.test(value.url);
}

module.exports = { Settings, DEFAULTS, SEARCH_ENGINES, NON_PERSISTED };
