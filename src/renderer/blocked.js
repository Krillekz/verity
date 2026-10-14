'use strict';

/**
 * Verity's error document.
 *
 * Loaded into the tab itself when a main-frame load fails, or when the omnibox
 * resolves to a scheme Verity refuses. The address bar keeps showing the address
 * that failed, because the main process preserves it on the tab.
 */

const page = window.verityPage;
const params = new URLSearchParams(location.search);

const reason = params.get('reason') || 'network';
const rawUrl = params.get('url') || '';
const code = params.get('code') || '';
const detail = params.get('detail') || '';

const CONTENT = {
  network: {
    badge: 'unreachable',
    title: (host) => `Verity could not reach ${host}`,
    explanation:
      'The connection failed before any page could be loaded. Nothing was sent to this site beyond the request you asked for, and no tracking parameters travelled with it.',
    hint: '',
  },
  tls: {
    badge: 'insecure connection',
    title: (host) => `${host} refused an encrypted connection`,
    explanation:
      'Verity tried HTTPS first and the site either does not support it or presented a connection it could not secure. Verity will not downgrade you to plain HTTP without being told to, because everything you send would then be readable in transit.',
    hint: 'Allowing HTTP adds a permanent per-site exception you can undo in the shield panel.',
  },
  scheme: {
    badge: 'refused',
    title: () => 'Verity will not open that address',
    explanation:
      'Only http, https and Verity’s own pages can be opened from the address bar. Schemes such as javascript:, data:, file: and chrome: are rejected on purpose — they are a common way to trick a browser into running someone else’s code.',
    hint: '',
  },
};

const content = CONTENT[reason] || CONTENT.network;
const host = (() => {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return rawUrl || 'that address';
  }
})();

// The flat-faced Verity: same character, no smile, because the page did not load.
const face = document.getElementById('verity-face');
if (face && globalThis.verityMascot) face.innerHTML = globalThis.verityMascot({ size: 92, mood: 'flat' });
const favicon = document.getElementById('favicon');
if (favicon && globalThis.verityFavicon) favicon.href = globalThis.verityFavicon();

document.getElementById('badge').textContent = content.badge;
document.getElementById('title').textContent = content.title(host);
document.getElementById('explanation').textContent = content.explanation;
document.getElementById('address').textContent = rawUrl || '(nothing)';
document.getElementById('detail').textContent = [detail, code ? `error ${code}` : ''].filter(Boolean).join(' · ');
document.getElementById('hint').textContent = content.hint;

const proceedButton = document.getElementById('proceed');
if (reason === 'tls') proceedButton.hidden = false;

document.getElementById('retry').addEventListener('click', () => {
  if (page) page.retry();
});

proceedButton.addEventListener('click', () => {
  if (page) page.proceedUnsafe(rawUrl);
});

document.getElementById('home').addEventListener('click', () => {
  if (page) page.navigate('verity://newtab');
});

document.getElementById('shield').addEventListener('click', () => {
  if (page) page.openPanel('shield');
});
