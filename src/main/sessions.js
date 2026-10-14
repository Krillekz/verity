'use strict';

const fs = require('fs');
const path = require('path');
const { protocol, session, app } = require('electron');

const { hardenSession } = require('./privacy');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');

/** `verity://<host>` maps to a page; extra path segments resolve within renderer/. */
const INTERNAL_PAGES = {
  chrome: 'chrome.html',
  panel: 'panel.html',
  newtab: 'newtab.html',
  about: 'about.html',
  blocked: 'blocked.html',
  settings: 'about.html',
  welcome: 'newtab.html',
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** Permissions Verity grants without asking, because they cannot exfiltrate data. */
const BENIGN_PERMISSIONS = new Set([
  'fullscreen',
  'pointerLock',
  'keyboardLock',
  'clipboard-sanitized-write',
  'window-management',
]);

/**
 * Declares the `verity://` scheme. MUST be called before `app.whenReady()`.
 */
function registerInternalScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'verity',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

/** Map a verity:// URL to an on-disk file inside renderer/, or null. */
function resolveInternalFile(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = (parsed.hostname || 'newtab').toLowerCase();
  let relative;
  try {
    relative = decodeURIComponent(parsed.pathname || '').replace(/^\/+/, '');
  } catch {
    return null; // malformed percent-encoding
  }
  relative = relative || INTERNAL_PAGES[host] || 'newtab.html';

  // The URL parser already collapses `/../`, but percent-encoded traversal is
  // decoded above, so refuse any parent segment explicitly before resolving.
  if (relative.split(/[\\/]+/).some((segment) => segment === '..' || segment === '.')) return null;

  const target = path.resolve(RENDERER_DIR, relative);
  const rel = path.relative(RENDERER_DIR, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return target;
}

/**
 * Owns every Electron session. Verity runs either in ephemeral mode (a fresh
 * in-memory partition, nothing touches disk) or in a persistent profile.
 */
class SessionManager {
  constructor({ settings, blocklist, stats, onNotice, onBlocked }) {
    this.settings = settings;
    this.blocklist = blocklist;
    this.stats = stats;
    this.onNotice = onNotice || (() => {});
    this.onBlocked = onBlocked || (() => {});
    this.privateCounter = 0;
    this.byWindow = new Map();
    this.hardened = new WeakSet();
    this.protocolReady = false;
  }

  /** Install the verity:// handler on a session (idempotent per session). */
  attachProtocol(ses) {
    if (!ses || ses.__verityProtocol) return;
    ses.__verityProtocol = true;
    ses.protocol.handle('verity', async (request) => {
      const file = resolveInternalFile(request.url);
      if (!file) {
        return new Response('Blocked internal path', { status: 400, headers: { 'content-type': 'text/plain' } });
      }
      try {
        const data = await fs.promises.readFile(file);
        return new Response(data, {
          status: 200,
          headers: {
            'content-type': MIME_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
            'cache-control': 'no-store',
            // Verity's own documents may only run their own scripts. Images are
            // allowed so the chrome strip can paint site favicons, and those URLs
            // are already restricted to the site's own host in tabs.js.
            'content-security-policy':
              "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: http:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
          },
        });
      } catch {
        return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
      }
    });
  }

  /**
   * Harden a session: privacy rules, a clean user agent, default-deny
   * permissions and a download handler that never auto-opens anything.
   */
  attachSecurity(ses, label) {
    if (!ses) return;
    this.attachProtocol(ses);
    if (this.hardened.has(ses)) return;
    this.hardened.add(ses);

    const cleanUserAgent = buildCleanUserAgent();
    if (this.settings.get('reduceFingerprinting')) {
      try {
        ses.setUserAgent(cleanUserAgent);
      } catch (err) {
        console.error('[verity] setUserAgent failed:', err.message);
      }
    }

    hardenSession(ses, {
      settings: this.settings,
      blocklist: this.blocklist,
      stats: this.stats,
      label,
      onBlocked: this.onBlocked,
    });

    // --- Permissions: deny by default, and never silently grant a site. ----
    const allows = (origin) => {
      const host = safeHost(origin);
      if (!host) return false;
      const exception = this.settings.siteException(host);
      return Boolean(exception && exception.permissions === true);
    };

    ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
      const origin = details && details.requestingUrl;
      if (BENIGN_PERMISSIONS.has(permission)) return callback(true);
      if (this.settings.get('denyPermissionsByDefault') && !allows(origin)) {
        this.onNotice({
          level: 'privacy',
          text: `Blocked "${permission}" request from ${safeHost(origin) || 'a site'}.`,
        });
        return callback(false);
      }
      callback(!this.settings.get('denyPermissionsByDefault'));
    });

    ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
      if (BENIGN_PERMISSIONS.has(permission)) return true;
      if (!this.settings.get('denyPermissionsByDefault')) return true;
      return allows(requestingOrigin);
    });

    // --- Downloads: always to the Downloads folder, never auto-launched. ---
    ses.on('will-download', (event, item) => {
      this.onNotice({
        level: 'info',
        text: `Downloading ${item.getFilename()}…`,
      });
      item.once('done', (_e, state) => {
        this.onNotice({
          level: state === 'completed' ? 'success' : 'error',
          text: state === 'completed' ? `Saved ${item.getFilename()}` : `Download ${state}: ${item.getFilename()}`,
        });
      });
    });
  }

  /** The session a new window should use, honouring ephemeral mode. */
  forWindow(windowId) {
    const existing = this.byWindow.get(windowId);
    if (existing) return existing;

    const ephemeral = this.settings.get('ephemeralMode');
    let ses;
    if (ephemeral) {
      this.privateCounter += 1;
      ses = session.fromPartition(`verity-private-${this.privateCounter}`);
    } else {
      ses = session.fromPartition('persist:verity');
    }
    this.attachSecurity(ses, ephemeral ? `ephemeral-${windowId}` : 'persistent');
    this.byWindow.set(windowId, ses);
    return ses;
  }

  /** A brand-new isolated in-memory session (used by private windows). */
  newPrivateSession() {
    this.privateCounter += 1;
    const ses = session.fromPartition(`verity-private-${this.privateCounter}`);
    this.attachSecurity(ses, `ephemeral-${this.privateCounter}`);
    return ses;
  }

  isEphemeral(ses) {
    return Boolean(ses) && !String(ses.storagePath || '').length;
  }

  releaseWindow(windowId) {
    const ses = this.byWindow.get(windowId);
    this.byWindow.delete(windowId);
    return ses;
  }

  /** Wipe everything a session knows. Returns a small report. */
  async clear(ses) {
    if (!ses) return { ok: false, reason: 'no session' };
    const report = { storage: true, cache: true };
    await Promise.allSettled([
      ses.clearStorageData(),
      ses.clearCache(),
      ses.clearHostResolverCache(),
      ses.clearAuthCache(),
    ]).then((results) => {
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          if (index === 0) report.storage = false;
          if (index === 1) report.cache = false;
        }
      });
    });
    this.stats.perTab.clear();
    this.stats.session = { blocked: 0, upgraded: 0, parametersStripped: 0, cookiesBlocked: 0 };
    return { ok: report.storage && report.cache, ...report };
  }

  async clearAll() {
    const sessions = new Set([...this.byWindow.values()]);
    sessions.add(session.defaultSession);
    const reports = [];
    for (const ses of sessions) {
      if (!ses) continue;
      try {
        reports.push(await this.clear(ses));
      } catch {
        reports.push({ ok: false });
      }
    }
    return { ok: reports.every((r) => r.ok), sessions: reports.length };
  }

  /** Wipe on shutdown when the user has asked us to. */
  async clearOnExitIfEnabled() {
    if (!this.settings.get('clearOnExit')) return;
    try {
      await session.defaultSession.clearStorageData();
      await session.defaultSession.clearCache();
    } catch {
      /* best effort on shutdown */
    }
  }
}

function buildCleanUserAgent() {
  const chromeVersion = String(process.versions.chrome || '120').split('.')[0];
  const platform =
    process.platform === 'win32'
      ? 'Windows NT 10.0; Win64; x64'
      : process.platform === 'darwin'
        ? 'Macintosh; Intel Mac OS X 10_15_7'
        : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion}.0.0.0 Safari/537.36`;
}

function safeHost(origin) {
  try {
    const url = new URL(origin);
    if (url.protocol === 'verity:' || url.protocol === 'file:') return url.hostname || 'internal';
    return url.hostname;
  } catch {
    return '';
  }
}

module.exports = {
  SessionManager,
  registerInternalScheme,
  resolveInternalFile,
  buildCleanUserAgent,
  INTERNAL_PAGES,
  RENDERER_DIR,
};
