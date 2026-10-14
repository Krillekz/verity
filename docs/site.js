'use strict';

/**
 * Verity's project site.
 *
 * Three generated files arrive before this one:
 *   assets/verity-art.js     the app's own icons.js — mascot, mark, icon set
 *   assets/verity-engine.js  the app's blocklist.js + search.js, in a page
 *   assets/verity-data.js    numbers measured from the sources at build time
 *
 * Everything drawn here comes from those, so the page cannot describe a browser
 * that no longer exists. The demo panels call the real modules; nothing is
 * re-implemented for the website.
 */

const art = window.VERITY_ART;
const engine = window.VERITY_ENGINE;
const data = window.VERITY_DATA;

const $ = (id) => document.getElementById(id);

/**
 * replaceChildren(), but null arguments are dropped rather than stringified.
 * The DOM turns a null child into the literal text "null", which is a quiet
 * way to publish a bug, so every conditional child goes through here.
 */
function draw(node, ...children) {
  node.replaceChildren(...children.flat().filter(Boolean));
  return node;
}

/** Same shape as the helper the app's own pages use. */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
  return node;
}

if (!art || !engine || !data) {
  console.error('The generated assets did not load — run: node tools/build-site.js');
}

/** The browser's own rule engine, built from assets/verity-engine.js. */
const blocklist = engine ? new engine.Blocklist() : null;

/* ------------------------------------------------------------------ theme */

const THEME_KEY = 'verity-site-theme';

function paintTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const light = theme === 'light';
  $('theme-label').textContent = light ? 'Dark' : 'Light';
  $('theme-glyph').innerHTML = light
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M20.5 14.3A8.5 8.5 0 0 1 9.7 3.5a8.5 8.5 0 1 0 10.8 10.8z"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 3.6v2.1M12 18.3v2.1M4.6 12h2.1M17.3 12h2.1M6.6 6.6l1.5 1.5M15.9 15.9l1.5 1.5M17.4 6.6l-1.5 1.5M8.1 15.9l-1.5 1.5"/></svg>';
}

function initTheme() {
  let stored = null;
  try {
    stored = localStorage.getItem(THEME_KEY);
  } catch {
    stored = null;
  }
  paintTheme(stored === 'light' ? 'light' : 'dark');
  $('theme').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    paintTheme(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* a page that cannot remember a colour is not worth failing over */
    }
  });
}

/* ------------------------------------------------------- draw the interface */

const TAB_ONE = 'Verity';
const TAB_TWO = 'example.com';

function drawWindow() {
  document.querySelectorAll('.brand-mark').forEach((slot) => {
    slot.innerHTML = art.mark({ size: 22 });
  });
  $('favicon').setAttribute('href', art.favicon(64));
  $('rig-face').innerHTML = art.mascot({ size: 64 });

  const tabs = [
    { title: TAB_ONE, on: true, icon: art.mark({ size: 13 }) },
    { title: TAB_TWO, on: false, icon: art.icons.globe.replace('width="16" height="16"', 'width="13" height="13"') },
  ];
  $('rig-tabs').replaceChildren(
    ...tabs.map((tab) => el('span', { class: `rig-tab${tab.on ? ' on' : ''}` }, el('span', { html: tab.icon }), el('span', { text: tab.title })))
  );
  $('rig-nav').innerHTML = art.icons.back + art.icons.forward + art.icons.reload + art.icons.home;
  $('rig-right').innerHTML = art.icons.shieldCheck + art.icons.menu;
  $('rig-newtab').innerHTML = art.icons.plus;
  $('rig-star').innerHTML = art.icons.starOn;
  $('omnibox').insertBefore(el('span', { class: 'chip', html: art.icons.lock }), $('url-input'));

  const rules = data.filterList.total;
  $('rig-cards').replaceChildren(
    ...[
      [String(rules), 'filter rules, measured from blocklist.js', true],
      [String(data.trackingParams.length), 'tracking parameters stripped on the way out', false],
      ['0', 'bytes of browsing data written to disk by default', false],
    ].map(([value, label, accent]) =>
      el('div', { class: `rig-card${accent ? ' accent' : ''}` }, el('b', { text: value }), el('span', { text: label }))
    )
  );

  $('build-line').textContent =
    `v${data.product.version} · ${rules} rules across ${Object.keys(data.filterList.byCategory).length} categories · ` +
    `${data.trackingParams.length} tracking parameters · Electron, Windows x64`;
}

/* ---------------------------------------------------------------- omnibox */

function describeResolution(input) {
  const resolved = engine.resolveInput(input, 'duckduckgo');
  const host = (() => {
    try {
      return new URL(resolved.url).hostname;
    } catch {
      return '';
    }
  })();
  const hit = blocklist && host ? blocklist.match(host) : null;

  const kind =
    resolved.kind === 'search'
      ? 'a search query'
      : resolved.kind === 'homepage'
        ? 'the home page'
        : 'an address';

  return { resolved, host, hit, kind };
}

function paintResolution(input) {
  const box = $('rig-result');

  if (!input.trim()) {
    box.textContent =
      'Type above: the address bar is the browser\'s own resolver, so this tells you where it would actually go.';
    return;
  }

  const { resolved, host, hit, kind } = describeResolution(input);
  const parts = [
    el('span', { text: `resolveInput() reads that as ${kind} — ` }),
    el('b', { text: resolved.url }),
  ];
  if (hit) {
    parts.push(el('span', { text: ` · ${host} is on the filter list (${hit.category}), so the request would be blocked` }));
  } else if (host) {
    parts.push(el('span', { text: ` · ${host} is not on the list, so it would be fetched over ${resolved.url.startsWith('https') ? 'HTTPS' : 'the scheme given'}` }));
  }
  box.replaceChildren(...parts);
}

function initOmnibox() {
  const input = $('url-input');
  input.addEventListener('input', () => paintResolution(input.value));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      paintResolution(input.value);
    }
  });
}

/* ------------------------------------------------------------ demo: hosts */

const HOST_CHIPS = ['ad.doubleclick.net', 'doubleclick.net', 'notdoubleclick.net', 'google-analytics.com', 'cdn.jsdelivr.net', 'coinhive.com'];
const URL_CHIPS = [
  'https://shop.example.com/item?utm_source=news&utm_medium=email&id=42',
  'https://example.com/article?fbclid=IwAR9&keep=1',
];

const tally = { checks: 0, stripped: 0, blocked: 0 };

const counters = [
  { key: 'rules', value: () => String(data.filterList.total), label: 'rules in the built-in list', accent: false },
  { key: 'checks', value: () => String(tally.checks), label: 'checks you have run', accent: true },
  { key: 'stripped', value: () => String(tally.stripped), label: 'tracking parameters stripped', accent: false },
  { key: 'blocked', value: () => String(tally.blocked), label: 'hosts that would be blocked', accent: false },
];

function paintCounters() {
  $('counters').replaceChildren(
    ...counters.map((counter) =>
      el(
        'div',
        { class: `counter${counter.accent ? ' accent' : ''}` },
        el('b', { text: counter.value() }),
        el('span', { text: counter.label })
      )
    )
  );
}

function paintHostVerdict(host) {
  const box = $('host-verdict');
  const value = String(host || '').trim();
  if (!value) {
    box.className = 'verdict';
    box.textContent = 'Waiting for a hostname.';
    return;
  }
  if (!blocklist) {
    box.textContent = 'The generated engine did not load — run: node tools/build-site.js';
    return;
  }
  const hit = blocklist.match(value);
  tally.checks += 1;
  if (hit) tally.blocked += 1;

  const same = hit && hit.domain === value;
  box.className = `verdict ${hit ? 'blocked' : 'allowed'}`;
  draw(
    box,
    el('span', { class: 'tag', text: hit ? 'BLOCKED' : 'ALLOWED' }),
    hit
      ? el('span', { text: same ? `${value} is on the list as ` : `${value} is on the list through its parent domain ` })
      : el('span', { text: `${value} is not on the list` }),
    hit ? el('code', { text: hit.domain }) : null,
    hit ? el('span', { text: ` — category ${hit.category}, ${data.filterList.byCategory[hit.category]} rules like it. A request to it never leaves the machine.` }) : null,
    !hit
      ? el('span', { text: ', so the request proceeds — cleaned of tracking parameters and third-party cookies.' })
      : null,
    hit && !same
      ? el('span', { class: 'was', text: `matched on the suffix boundary: ${hit.domain} is the listed entry, not the full hostname` })
      : null
  );
  paintCounters();
}

function paintUrlVerdict(raw) {
  const box = $('url-verdict');
  const value = String(raw || '').trim();
  if (!value) {
    box.className = 'verdict';
    box.textContent = 'Waiting for a URL.';
    return;
  }

  let parsed = null;
  try {
    parsed = new URL(value);
  } catch {
    box.className = 'verdict';
    box.replaceChildren(
      el('span', { class: 'tag', text: 'NOT A URL' }),
      el('span', { text: 'The omnibox resolver would treat that as a search query instead, and send it to your chosen engine.' })
    );
    return;
  }

  if (!blocklist || !engine) {
    box.textContent = 'The generated engine did not load — run: node tools/build-site.js';
    return;
  }

  const cleaned = engine.stripTrackingParams(value);
  const removed = (() => {
    if (!cleaned) return [];
    const after = new Set(new URL(cleaned).searchParams.keys());
    return [...new Set(parsed.searchParams.keys())].filter((key) => !after.has(key));
  })();
  const hit = blocklist.match(parsed.hostname);

  tally.checks += 1;
  if (hit) tally.blocked += 1;
  if (removed.length) tally.stripped += removed.length;

  box.className = `verdict ${hit ? 'blocked' : 'allowed'}`;
  draw(
    box,
    el('span', { class: 'tag', text: hit ? 'HOST BLOCKED' : 'HOST ALLOWED' }),
    el('span', { text: `${parsed.hostname} ${hit ? `is on the list (${hit.category})` : 'is not on the list'}.` }),
    removed.length
      ? el('span', { text: ` ${removed.length} tracking parameter${removed.length === 1 ? '' : 's'} removed before the request:` })
      : el('span', { text: ' Nothing to strip: no known tracking parameter in this URL.' }),
    removed.length ? el('ul', {}, ...removed.map((key) => el('li', {}, el('code', { text: key })))) : null,
    removed.length ? el('span', { class: 'was', text: value }) : null,
    removed.length ? el('span', { class: 'now', text: cleaned }) : null,
    parsed.searchParams.toString() && !removed.length
      ? el('span', { class: 'now', text: `Query kept as-is: ${parsed.search.toString()}` })
      : null
  );
  paintCounters();
}

function initHostPanel() {
  const input = $('host-input');
  $('host-form').addEventListener('submit', (event) => {
    event.preventDefault();
    paintHostVerdict(input.value);
  });
  input.addEventListener('input', () => {
    if (!input.value.trim()) paintHostVerdict('');
  });
  $('host-chips').replaceChildren(
    ...HOST_CHIPS.map((host) =>
      el('button', {
        class: 'chip-btn',
        type: 'button',
        text: host,
        onclick: () => {
          input.value = host;
          paintHostVerdict(host);
        },
      })
    )
  );
  $('icon-host').innerHTML = art.icons.shieldCheck;
}

function initUrlPanel() {
  const input = $('url-input-demo');
  $('url-form').addEventListener('submit', (event) => {
    event.preventDefault();
    paintUrlVerdict(input.value);
  });
  input.addEventListener('input', () => {
    if (!input.value.trim()) paintUrlVerdict('');
  });
  $('url-chips').replaceChildren(
    ...URL_CHIPS.map((url) =>
      el('button', {
        class: 'chip-btn',
        type: 'button',
        text: url.length > 46 ? `${url.slice(0, 44)}…` : url,
        onclick: () => {
          input.value = url;
          paintUrlVerdict(url);
        },
      })
    )
  );
  $('icon-url').innerHTML = art.icons.bolt;
}

/* ---------------------------------------------------------------- content */

const FEATURES = [
  {
    icon: 'bookmarks',
    title: 'Tabbed browsing',
    body: 'A real omnibox that tells addresses from searches, back/forward/reload/stop, zoom, find-in-page, bookmarks, and session restore — each tab an isolated <b>WebContentsView</b>.',
  },
  {
    icon: 'shieldCheck',
    title: 'Tracker and ad blocking',
    body: `${data.filterList.total} curated rules matched on a hostname <b>boundary</b>, counted per tab and per window, with per-site exceptions. Not a full EasyList — a list that keeps sites working.`,
  },
  {
    icon: 'lock',
    title: 'HTTPS-only',
    body: 'Plain <code>http://</code> requests are upgraded, and <b>refused</b> if the upgrade fails rather than quietly downgraded. Per-site exceptions can be reversed.',
  },
  {
    icon: 'incognito',
    title: 'Third-party cookies and storage blocked',
    body: 'Dropped for sub-resources and sub-frames, never on a top-level navigation — so signing in still works while cross-site tracking does not.',
  },
  {
    icon: 'trash',
    title: 'Tracking parameters stripped',
    body: `utm_*, fbclid, gclid and ${data.trackingParams.length - 3} more are removed from navigations and subresources <b>before they leave the machine</b>. Try it above.`,
  },
  {
    icon: 'globe',
    title: 'Fingerprint reduction',
    body: 'A generic Chrome user agent, coarse client hints, and no cross-site referrer, so a site sees less about the machine than it would otherwise.',
  },
  {
    icon: 'check',
    title: 'Do Not Track and Global Privacy Control',
    body: 'Both headers on every request. They are requests, not commands — but they cost nothing and some sites honour them.',
  },
  {
    icon: 'warn',
    title: 'Permissions denied by default',
    body: 'Camera, microphone, geolocation and notifications are refused until you allow them, and the allow is per site.',
  },
  {
    icon: 'bolt',
    title: 'Ephemeral by default',
    body: 'Each window runs in an in-memory session partition that is destroyed on exit, and storage is wiped when the last window closes.',
  },
  {
    icon: 'gear',
    title: 'Internal pages on a private scheme',
    body: 'The new tab, the shield report, settings, bookmarks, the blocked-request interstitial and About are all <code>verity://</code> documents, not files on disk.',
  },
  {
    icon: 'info',
    title: 'Profiles, side by side',
    body: 'A profile keeps everything Verity owns — settings, bookmarks, per-site exceptions — in one directory you can find and delete. A name with a path separator in it is refused rather than guessed at.',
  },
];

const NOT_BUILT = [
  ['No extensions.', 'There is no extension system, and no plan for one in this version.'],
  ['No sync, and no accounts.', 'Nothing about the browser talks to a server of ours: there is no ours.'],
  ['No history or downloads manager.', 'Downloads are handled, but there is no list to browse afterwards, because by default there is nothing to list.'],
  ['No automatic filter-list updates.', 'The built-in list ships in the source. A hosts-format list can be loaded from Settings when you want one.'],
  ['Not code-signed, and Windows x64 only.', 'An unsigned installer warns on first run; macOS and Linux need icon assets that do not exist yet.'],
];

const RUN_LIMITS = [
  ['findInPage cannot be verified headlessly.', 'It returns nothing to a window that never composited, so the smoke suite reports it as a skip and the diagnose suite proves the same flow against a real window. A skip is never counted as a pass.'],
  ['A window capture cannot contain the panel.', 'On this desktop a capture photographs whatever is on top of the window, so the panel is verified by view geometry, visibility and DOM content instead.'],
  ['The filter list is curated, not exhaustive.', 'High-confidence ad, tracking, fingerprinting, session-recording and cryptomining hosts — chosen so that normal sites keep working.'],
];

const INSTALL_BLOCKS = [
  {
    title: 'Run it from source',
    body: 'Node 20+ and a desktop session. This is the fastest way to see it move.',
    lines: ['npm install', 'npm start', 'npm run verify'],
    note: 'verify runs the headless suite and then the real-window one.',
  },
  {
    title: 'Build the installer',
    body: 'Produces a real Windows application. It installs per user, so it needs no administrator rights, and it adds Start menu and desktop shortcuts.',
    lines: ['npm run dist'],
    note: 'dist/Verity-Setup-0.1.0.exe · unsigned, so Windows warns on first run',
  },
  {
    title: 'Or just the app, without installing',
    body: 'Stops after the unpacked build, which is much faster when you only want to try a change. The icon is redrawn from the mascot grid first.',
    lines: ['npm run pack', 'npm run desktop:new'],
    note: 'dist/win-unpacked/Verity.exe · desktop:new opens a fresh virtual desktop for a second profile',
  },
];

const TREE = `src/main/
  main.js       app lifecycle, windows, menus, IPC gateway (security boundary)
  tabs.js       tab model: view creation, activation, layout, find-in-page
  sessions.js   per-window partitions, verity:// protocol, permissions, downloads
  privacy.js    request filtering, HTTPS upgrade, headers, cookies, fingerprint
  blocklist.js  rule parsing and hostname-boundary matching
  settings.js   typed settings store with per-site exceptions
  search.js     omnibox input resolution
src/preload/
  chrome.js     the privileged bridge — only verity://chrome and verity://panel
  page.js       the narrow bridge for verity:// pages
src/renderer/
  chrome.html   tab strip, toolbar, omnibox, find bar, bookmarks bar
  panel.html    the side panel: shield, settings, bookmarks, menu
  newtab / blocked / about
tools/
  build-site.js  builds this website from the files above
  make-icon.js   draws assets/icon.png and .ico from the mascot grid`;

function initContent() {
  $('features').replaceChildren(
    ...FEATURES.map((feature) =>
      el(
        'article',
        { class: 'feature' },
        el('span', { class: 'feature-glyph', html: art.icons[feature.icon] || art.icons.info }),
        el('div', {}, el('h4', { text: feature.title }), el('p', { html: feature.body }))
      )
    )
  );

  $('not-built').replaceChildren(
    ...NOT_BUILT.map(([lead, rest]) => el('li', {}, el('b', { text: `${lead} ` }), el('span', { text: rest })))
  );
  $('run-limits').replaceChildren(
    ...RUN_LIMITS.map(([lead, rest]) => el('li', {}, el('b', { text: `${lead} ` }), el('span', { text: rest })))
  );

  $('install-blocks').replaceChildren(
    ...INSTALL_BLOCKS.map((block) =>
      el(
        'article',
        { class: 'install-block' },
        el('h4', { text: block.title }),
        el('p', { text: block.body }),
        ...block.lines.map((line) => el('pre', {}, el('code', { text: line }))),
        el(
          'div',
          { class: 'copy-row' },
          el('span', { class: 'out-path', text: block.note }),
          el('button', {
            class: 'copy-btn',
            type: 'button',
            text: 'Copy commands',
            onclick: (event) => {
              const text = block.lines.join('\n');
              const button = event.currentTarget;
              const done = () => {
                button.textContent = 'Copied';
                setTimeout(() => {
                  button.textContent = 'Copy commands';
                }, 1600);
              };
              if (navigator.clipboard && window.isSecureContext) {
                navigator.clipboard.writeText(text).then(done, () => {
                  button.textContent = 'Select and copy';
                });
              } else {
                button.textContent = 'Select and copy';
              }
            },
          })
        )
      )
    )
  );

  $('tree').textContent = TREE;

  // replaceChildren() stringifies a null argument, so the separators are
  // filtered rather than left for the DOM to turn into the text "null".
  const flags = data.defaults
    .flatMap((name, index) => [index ? el('span', { text: ', ' }) : null, el('code', { text: name })])
    .filter(Boolean);
  $('defaults-line').replaceChildren(
    el('span', { text: `On first launch all ${data.defaults.length} protective switches are already on: ` }),
    ...flags,
    el('span', { text: '.' })
  );

  $('foot-version').textContent = `v${data.product.version} · ${data.filterList.total} rules`;
  const probes = $('probe-count');
  if (probes && data.probes) probes.textContent = String(data.probes);
}

/* -------------------------------------------------------------------- boot */

function boot() {
  if (!art || !engine || !data) return;
  initTheme();
  drawWindow();
  initOmnibox();
  initHostPanel();
  initUrlPanel();
  initContent();
  paintCounters();
}

boot();
