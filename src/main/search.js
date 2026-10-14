'use strict';

const { SEARCH_ENGINES } = require('./settings');

/** Schemes we will hand straight to the engine instead of the search box. */
const KNOWN_SCHEMES = new Set([
  'http',
  'https',
  'file',
  'verity',
  'about',
  'chrome',
  'data',
  'blob',
  'view-source',
  'mailto',
  'tel',
  'ftp',
  'ws',
  'wss',
]);

const HOSTNAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.?$/i;
const IPV4_PATTERN = /^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/.*)?$/;

/**
 * Decide whether omnibox input is a URL or a search query, and normalise it.
 *
 * @param {string} raw      whatever the user typed
 * @param {string} engine   search engine key
 * @param {string} homepage fallback for empty input
 * @returns {{url: string, kind: 'url'|'search'|'homepage', searchEngine?: string, query?: string}}
 */
function resolveInput(raw, engine = 'duckduckgo', homepage = 'verity://newtab') {
  const input = String(raw == null ? '' : raw).trim();
  if (!input) return { url: homepage, kind: 'homepage' };

  // 1. Anything with an explicit, recognised scheme is taken literally.
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(input);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    // "localhost:3000" and "example.com:8080" must not be mistaken for schemes.
    const looksLikeHostPort = scheme === 'localhost' || isAllDigits(input.slice(scheme.length + 1).split(/[/?#]/)[0]);
    if (KNOWN_SCHEMES.has(scheme) && !looksLikeHostPort) {
      return { url: input, kind: 'url' };
    }
    if (looksLikeHostPort && (scheme === 'localhost' || input.includes('.'))) {
      return { url: `https://${input}`, kind: 'url' };
    }
  }

  // 2. Bare hostnames, IPs, localhost and paths.
  if (looksLikeUrl(input)) {
    return { url: `https://${input}`, kind: 'url' };
  }

  // 3. Everything else is a search query.
  return { ...searchUrl(input, engine), kind: 'search', query: input };
}

function looksLikeUrl(input) {
  if (/^localhost(:\d+)?(\/|$|\?|#)/i.test(input)) return true;
  if (IPV4_PATTERN.test(input)) return true;
  if (input.startsWith('/')) return true;

  const withoutPort = input.split(/[/?#]/)[0];
  const host = withoutPort.includes(':') ? withoutPort.slice(0, withoutPort.lastIndexOf(':')) : withoutPort;
  if (!host) return false;
  // Single-label input stays a search term ("weather" is a query, not a host).
  if (!host.includes('.')) return false;
  if (!HOSTNAME_PATTERN.test(host)) return false;
  const tld = host.slice(host.lastIndexOf('.') + 1);
  return /^[a-z]{2,}$/i.test(tld) && !/^\d+$/.test(tld);
}

function isAllDigits(value) {
  return value.length > 0 && /^\d+$/.test(value);
}

function searchUrl(query, engine = 'duckduckgo') {
  const config = SEARCH_ENGINES[engine] || SEARCH_ENGINES.duckduckgo;
  return {
    url: config.query.replace('%s', encodeURIComponent(query)),
    searchEngine: engine,
    query,
  };
}

module.exports = { resolveInput, searchUrl, looksLikeUrl, KNOWN_SCHEMES };
