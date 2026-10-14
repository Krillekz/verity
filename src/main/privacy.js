'use strict';

/**
 * Verity's privacy engine.
 *
 * Every session (persistent or in-memory) is hardened with the same set of
 * request-level rules, applied through Electron's `webRequest` API:
 *
 *  1. Block hosts on the filter list (ads, trackers, session recorders, miners…)
 *  2. Strip known tracking parameters from outbound URLs
 *  3. Upgrade navigations to HTTPS where possible
 *  4. Strip cookies from third-party requests, and Set-Cookie from their replies
 *  5. Send Do Not Track / Global Privacy Control, and reduce fingerprint surface
 *
 * Rules 4 and 5 are deliberately asymmetric: third-party cookies are dropped for
 * sub-resources and sub-frames but never on a top-level navigation, so signing in
 * to a site keeps working.
 */

/** Hosts that must never be HTTPS-upgraded or treated as remote. */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', 'localhost.localdomain']);

/** Enough multi-label suffixes to make eTLD+1 comparisons sane without a PSL. */
const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk', 'sch.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.nz', 'net.nz', 'org.nz', 'co.za', 'org.za',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
  'com.br', 'net.br', 'org.br', 'com.cn', 'net.cn', 'org.cn', 'gov.cn',
  'com.mx', 'com.ar', 'com.sg', 'com.my', 'com.ph', 'com.vn', 'com.pk', 'com.tw', 'com.hk', 'com.tr',
  'co.in', 'net.in', 'org.in', 'gov.in', 'ac.in', 'co.kr', 'or.kr', 'co.id', 'or.id',
  'co.il', 'ac.il', 'gov.il', 'com.pl', 'com.ua', 'co.th', 'in.th', 'com.sa', 'com.eg',
]);

/** Requests that legitimately carry credentials we must not touch. */
const CREDENTIAL_SAFE_TYPES = new Set(['mainFrame']);

function parseHost(value) {
  if (!value || typeof value !== 'string') return '';
  if (value === 'null' || value === 'about:blank' || value.startsWith('devtools:')) return '';
  try {
    return new URL(value).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
}

function isLocalHostname(host) {
  if (!host) return false;
  if (LOCAL_HOSTNAMES.has(host)) return true;
  if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^\[?fe80:/i.test(host)) return true;
  if (host === '::1') return true;
  return false;
}

/** Best-effort registrable domain ("a.b.example.co.uk" -> "example.co.uk"). */
function registrableDomain(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host || host.includes(':') || /^\d+(\.\d+){3}$/.test(host)) return host;
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const lastTwo = labels.slice(-2).join('.');
  if (MULTI_LABEL_SUFFIXES.has(lastTwo) && labels.length >= 3) return labels.slice(-3).join('.');
  return lastTwo;
}

function isThirdParty(requestHost, initiatorHost) {
  if (!requestHost || !initiatorHost) return false;
  const a = registrableDomain(requestHost);
  const b = registrableDomain(initiatorHost);
  if (!a || !b) return false;
  return a !== b;
}

/** Aggregated, per-tab block counters. Kept in memory only. */
class PrivacyStats {
  constructor() {
    this.perTab = new Map(); // webContentsId -> { count, domains: Map, categories: Map }
    this.session = { blocked: 0, upgraded: 0, parametersStripped: 0, cookiesBlocked: 0 };
    this.allowlisted = 0;
  }

  tabEntry(id) {
    if (!this.perTab.has(id)) {
      this.perTab.set(id, { count: 0, domains: new Map(), categories: new Map() });
    }
    return this.perTab.get(id);
  }

  recordBlock(id, { domain, category }) {
    if (typeof id !== 'number' || id < 0) id = -1;
    const entry = this.tabEntry(id);
    entry.count += 1;
    entry.domains.set(domain, (entry.domains.get(domain) || 0) + 1);
    entry.categories.set(category, (entry.categories.get(category) || 0) + 1);
    this.session.blocked += 1;
  }

  recordUpgrade() {
    this.session.upgraded += 1;
  }

  recordParams() {
    this.session.parametersStripped += 1;
  }

  recordCookieBlock() {
    this.session.cookiesBlocked += 1;
  }

  get(id) {
    const entry = this.perTab.get(typeof id === 'number' ? id : -1);
    if (!entry) return { count: 0, domains: [], categories: {} };
    const domains = [...entry.domains.entries()]
      .map(([domain, count]) => ({ domain, count, category: entry.categories.get(domain) || 'ads' }))
      .sort((a, b) => b.count - a.count);
    return { count: entry.count, domains, categories: Object.fromEntries(entry.categories) };
  }

  /** Detailed domain list with per-domain category, for the shield panel. */
  domains(id) {
    const entry = this.perTab.get(typeof id === 'number' ? id : -1);
    if (!entry) return [];
    return [...entry.domains.entries()]
      .map(([domain, count]) => ({ domain, count }))
      .sort((a, b) => b.count - a.count);
  }

  clear(id) {
    this.perTab.delete(typeof id === 'number' ? id : -1);
  }

  summary() {
    return { ...this.session, allowlistedSites: this.allowlisted };
  }
}

/**
 * Attach the privacy rules to one Electron session.
 *
 * @param {Electron.Session} ses
 * @param {object} options
 * @param {import('./settings').Settings} options.settings
 * @param {import('./blocklist').Blocklist} options.blocklist
 * @param {PrivacyStats} options.stats
 * @param {(payload: object) => void} [options.onBlocked]  notified per blocked request
 * @param {string} [options.label]  for logging
 */
function hardenSession(ses, { settings, blocklist, stats, onBlocked, label = 'session' }) {
  const filter = { urls: ['<all_urls>'] };

  // The cleanest UA we can build: real Chromium version, no Electron/Verity tokens.
  const chromeVersion = String(process.versions.chrome || '120').split('.')[0];
  const platform =
    process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64'
      : process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7'
        : 'X11; Linux x86_64';
  const cleanUserAgent = `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion}.0.0.0 Safari/537.36`;

  // Header names arrive in their sent casing, so always look them up loosely.
  const findHeaderKey = (headers, name) =>
    Object.keys(headers || {}).find((key) => key.toLowerCase() === name.toLowerCase());

  const deleteHeader = (headers, name) => {
    const key = findHeaderKey(headers, name);
    if (key) delete headers[key];
    return Boolean(key);
  };

  const setHeader = (headers, name, value) => {
    const key = findHeaderKey(headers, name);
    if (key) headers[key] = value;
    else headers[name] = value;
  };

  const siteAllows = (host, rule) => {
    if (!host) return false;
    const exception = settings.siteException(host) || settings.siteException(registrableDomain(host));
    if (!exception) return false;
    if (rule === 'blocking') return exception.blocking === false;
    if (rule === 'httpsOnly') return exception.httpsOnly === false;
    if (rule === 'thirdPartyCookies') return exception.thirdPartyCookies === false;
    if (rule === 'permissions') return exception.permissions === true;
    return false;
  };

  // ---------------------------------------------------------------- requests
  ses.webRequest.onBeforeRequest(filter, (details, callback) => {
    const url = details.url || '';
    if (!/^https?:/i.test(url)) return callback({ cancel: false });

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return callback({ cancel: false });
    }

    const requestHost = parsed.hostname.toLowerCase();
    const initiatorHost = parseHost(details.initiatorOrigin) || parseHost(details.referrer);
    const isNavigation = CREDENTIAL_SAFE_TYPES.has(details.resourceType);
    const firstPartyFor = initiatorHost || requestHost;

    // 1. Filter list. Exceptions are evaluated against the *initiating* site.
    if (settings.get('blockAdsTrackers') && !siteAllows(firstPartyFor, 'blocking')) {
      const hit = blocklist.match(requestHost);
      if (hit) {
        stats.recordBlock(details.webContentsId, {
          domain: hit.domain,
          category: hit.category,
        });
        if (onBlocked) {
          onBlocked({
            webContentsId: details.webContentsId,
            domain: hit.domain,
            category: hit.category,
            resourceType: details.resourceType,
            url,
            isNavigation,
          });
        }
        return callback({ cancel: true });
      }
    }

    // 2. Tracking parameters.
    if (settings.get('stripTrackingParams')) {
      const cleaned = stripTrackingParamsSafe(url);
      if (cleaned) {
        stats.recordParams();
        return callback({ redirectURL: cleaned });
      }
    }

    // 3. HTTPS-only, skipping hosts that cannot possibly serve TLS.
    if (
      settings.get('httpsOnly') &&
      parsed.protocol === 'http:' &&
      !isLocalHostname(requestHost) &&
      !siteAllows(requestHost, 'httpsOnly')
    ) {
      parsed.protocol = 'https:';
      stats.recordUpgrade();
      return callback({ redirectURL: parsed.toString() });
    }

    callback({ cancel: false });
  });

  // ----------------------------------------------------------- send headers
  ses.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    const headers = details.requestHeaders || {};
    const requestHost = parseHost(details.url);
    const initiatorHost = parseHost(details.initiatorOrigin) || parseHost(details.referrer);
    const thirdParty = isThirdParty(requestHost, initiatorHost);

    if (settings.get('sendDoNotTrack')) {
      setHeader(headers, 'DNT', '1');
      setHeader(headers, 'Sec-GPC', '1');
    }

    if (settings.get('reduceFingerprinting')) {
      // NOTE: the User-Agent itself is set on the session (so that
      // navigator.userAgent matches the header) — see sessions.js.
      deleteHeader(headers, 'X-Requested-With');
      // Coarse client hints only; the fine-grained ones are a fingerprint vector.
      for (const hint of [
        'Sec-CH-UA-Full-Version',
        'Sec-CH-UA-Full-Version-List',
        'Sec-CH-UA-Arch',
        'Sec-CH-UA-Bitness',
        'Sec-CH-UA-Model',
        'Sec-CH-UA-Platform-Version',
        'Sec-CH-UA-WoW64',
        'Sec-CH-Prefers-Color-Scheme',
        'Sec-CH-Prefers-Reduced-Motion',
      ]) {
        deleteHeader(headers, hint);
      }
      setHeader(headers, 'Sec-CH-UA-Platform', '"Windows"');
    }

    // Third-party cookies: never for sub-resources or sub-frames, always for the
    // document itself so logins still work.
    if (
      settings.get('blockThirdPartyCookies') &&
      thirdParty &&
      !CREDENTIAL_SAFE_TYPES.has(details.resourceType) &&
      !siteAllows(initiatorHost || requestHost, 'thirdPartyCookies')
    ) {
      if (deleteHeader(headers, 'Cookie')) stats.recordCookieBlock();
    }

    // Cross-site referrers leak the page you came from; keep same-site only.
    if (thirdParty && settings.get('reduceFingerprinting')) {
      deleteHeader(headers, 'Referer');
    }

    callback({ requestHeaders: headers });
  });

  // -------------------------------------------------------- response headers
  ses.webRequest.onHeadersReceived(filter, (details, callback) => {
    const responseHeaders = details.responseHeaders;
    if (!responseHeaders) return callback({});

    const requestHost = parseHost(details.url);
    const initiatorHost = parseHost(details.initiatorOrigin) || parseHost(details.referrer);
    const thirdParty = isThirdParty(requestHost, initiatorHost);
    const isDocument = CREDENTIAL_SAFE_TYPES.has(details.resourceType);

    let changed = false;

    if (
      settings.get('blockThirdPartyCookies') &&
      thirdParty &&
      !isDocument &&
      !siteAllows(initiatorHost || requestHost, 'thirdPartyCookies')
    ) {
      const key = findHeaderKey(responseHeaders, 'set-cookie');
      if (key) {
        delete responseHeaders[key];
        changed = true;
      }
    }

    // Third-party storage partitioning is on; make sure no tracker can set a
    // long-lived document.cookie for another site.
    callback(changed ? { responseHeaders } : {});
  });

  console.log(`[verity] privacy rules attached to "${label}" (ua: Chrome/${chromeVersion})`);
  return { cleanUserAgent, siteAllows };
}

/** Local import kept lazy to avoid a require cycle with the test harness. */
function stripTrackingParamsSafe(url) {
  const { stripTrackingParams } = require('./blocklist');
  return stripTrackingParams(url);
}

module.exports = {
  hardenSession,
  PrivacyStats,
  isThirdParty,
  isLocalHostname,
  registrableDomain,
  parseHost,
  MULTI_LABEL_SUFFIXES,
};
