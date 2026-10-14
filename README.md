# Verity

A private desktop browser, built from scratch on Electron. Nothing is tracked by
default, nothing is written to disk unless you ask for it, and every privacy
switch is real — it changes what the network layer does, not just what the UI says.

```
npm install
npm start          # open Verity
npm run verify     # smoke suite + real-window checks
npm run dist       # build the Windows installer and a portable app
npm run icon       # redraw assets/icon.png and icon.ico from the mascot art
npm run site       # rebuild the project website in docs/ from src/
```

Requires Node 20+ and a desktop session (the browser renders real Chromium).

## The look

Verity is named after the smiling yellow sphere of the Minecraft horror series
that became a meme — a friendly assistant that turns out to know a little too
much. A browser is the perfect place for that joke, so the whole interface is
built around it: a bright, blocky, game-like surface (chunky corners, pixel
bevels, one yellow accent, a faint block grid behind everything) over a very dark
room. The mascot appears on the new tab page, at the head of the strip, in the
shield panel, on the error page (unsmiling), and as the window icon.

**The mascot is original artwork drawn for this project.** Verity the character
belongs to ThatMob's series and its art is not licensed for reuse, so Verity the
browser ships its own drawing in that visual language rather than someone else's
image. The art lives in one place — the `VERITY_MARK` grid in
[icons.js](src/renderer/icons.js) — and both the UI and `assets/icon.png` are
drawn from it, so the window icon can never drift from the face in the strip.

Dark is the default theme; `system` and `light` are settings, and the light
palette is a warm sunlit one rather than a neutral grey. The strip, the panel and
the internal pages all follow the setting, including a live switch with no reload
(internal pages read `prefers-color-scheme`, which the main process drives from
the theme setting).

## What it does

- **Tabbed browsing** with isolated `WebContentsView` surfaces per tab, a real
  omnibox that resolves addresses vs. searches, back/forward/reload/stop, zoom,
  find-in-page, bookmarks and session restore within a run.
- **Tracker and ad blocking** through a hostname-boundary rule engine, counted
  per tab and per window, with per-site exceptions.
- **HTTPS-only** that upgrades plain `http://` requests, and refuses them once an
  upgrade fails, plus per-site exceptions you can reverse.
- **Third-party cookies and storage blocked** by default; first-party cookies
  still work so sites stay usable.
- **Tracking parameters stripped** (`utm_*`, `fbclid`, `gclid`, …) from top-level
  navigations and subresources before they leave the machine.
- **Fingerprint reduction**: a generic Chrome user agent, coarse client hints,
  and no cross-site referrer.
- **Do Not Track / Global Privacy Control** headers on every request.
- **Permissions denied by default** — camera, microphone, geolocation,
  notifications — with a setting to allow them.
- **Ephemeral by default**: each window runs in an in-memory session partition
  that is destroyed on exit, and storage can be wiped when the last window closes.
- **Internal pages** over a private `verity://` scheme: new tab, shield report,
  settings, bookmarks, the blocked-request interstitial and About.

## Profiles, and a fresh desktop

Verity keeps everything it owns — settings, bookmarks, per-site exceptions — in one
directory. `--profile=name` gives an instance its own:

```
npm start -- --profile=work         # its own settings, side by side with the default
npm start -- --profile=D:\verity\scratch   # an absolute path is used as given
```

Named profiles live in `<app data>/Verity/profiles/<name>`, which is easy to find
and to delete, and the name is shown on the About page. Anything with a path
separator in it that is not an absolute path is refused rather than guessed at, so
a profile name cannot point the data directory somewhere unexpected.

Worth knowing what a profile does and does not separate: with ephemeral mode on
(the default) Verity writes no browsing data anywhere, so profiles are mostly
about *settings*. They matter most once you turn ephemeral mode off.

On Windows, `npm run desktop:new` opens a fresh virtual desktop — the same chord
Explorer listens for — so a second copy can live somewhere clean:

```
npm run desktop:new
npm start -- --profile=fresh
```

The script reads the desktop list out of the registry before and after and prints
the count, so you can see it worked rather than trusting a keystroke. It needs no
administrator rights, does not touch your open windows, and is reversible:
`Ctrl+Win+F4` closes the desktop you are on and `Ctrl+Win+Left` goes back. (That
is the honest version of "virtual desktop" on this machine: a second desktop, not
a virtual machine — the same session and the same disk, with a separate profile
for Verity's own data.)

## The website

`docs/` is the project's published site — live at
<https://krillekz.github.io/verity/> — and it is built from the app rather than
written alongside it:

```
npm run site               # regenerate docs/assets/ from src/
npm run site:serve         # serve docs/ at http://127.0.0.1:4173/
```

`tools/build-site.js` lifts four things out of the app, so the page cannot
describe a browser that no longer exists:

| Built from | Into | Why |
| --- | --- | --- |
| `src/renderer/icons.js` | `docs/assets/verity-art.js` | the mascot, the mark and the icon set are the app's own drawing code, loaded verbatim |
| `src/renderer/chrome.css` | `docs/assets/palette.css` | the palette tokens are extracted, not retyped — the same hex codes, both themes |
| `src/main/blocklist.js`, `src/main/search.js` | `docs/assets/verity-engine.js` | the site's "try the rules" panels call the real modules in a page |
| `src/main/blocklist.js`, `settings.js`, `package.json` | `docs/assets/verity-data.js` | every number on the page is measured at build time |

The panels are the point of it: typing a hostname runs the browser's own
`Blocklist.match()`, and pasting a URL runs its own `stripTrackingParams()`. The
web address bar drawn at the top of the page is the real `resolveInput()`, so it
answers with the engine the browser would actually use.

After generating, the build loads what it wrote in a sandbox and compares it
against the app across 72 probe cases — every icon size, a set of hostnames that
probe the suffix boundary, a set of URLs, and the omnibox resolver for every
search engine. A bundle that disagrees with the app fails the build instead of
shipping a website whose demo lies.

There is deliberately **no full-window screenshot** on the site. A window capture
on this desktop cannot contain the page surface or the panel (see the limits in
*Verification*), so the site draws the window from the app's palette and icons
instead, and says in a caption that it is a drawing.

The site needs no build step, no framework and no npm dependencies — it is plain
HTML, CSS and one script, and it works opened straight from the filesystem.

### Publishing it

The site is live at <https://krillekz.github.io/verity/>, published from
<https://github.com/Krillekz/verity> with **Settings → Pages → Source → GitHub
Actions**. Every push to `main` runs `.github/workflows/pages.yml`, which
rebuilds `docs/`, refuses to publish if the committed site is stale against
`src/`, and then deploys it.

To stand the same thing up from a fresh checkout:

```
git init -b main
git add . && git commit -m "Verity"
gh repo create verity --public --source=. --push
```

Do this **before** the first push, so the initial run cannot fail against a
Pages site that does not exist yet:

```
gh api -X POST repos/<owner>/verity/pages -f build_type=workflow
```

The plain alternative is **Source → Deploy from a branch → `main` / `docs`**,
which needs no workflow at all; in that case the stale-site check does not run,
so run `npm run site` yourself after changing anything the site draws.

## Installing it

`npm run dist` produces a real Windows application:

- `dist/Verity-Setup-0.1.0.exe` — an installer (NSIS) that installs per user, so
  it needs no administrator rights, and adds Start menu and desktop shortcuts.
- `dist/win-unpacked/Verity.exe` — the app itself, runnable without installing.

`npm run pack` stops after the unpacked app, which is much faster when you only
want to try a change. The build takes only the runtime files (`src/`, `assets/`,
`package.json`) into the asar; the tests and tools stay out.

The icons are generated, not hand-made: `npm run icon` draws both `assets/icon.png`
(what the running window passes to Electron) and the multi-size `assets/icon.ico`
(what Windows shows for the app and the installer) from the same mascot grid, and
`npm run dist` runs it first so a stale icon cannot be packaged.

Two things the build does not do: it does not code-sign (an unsigned installer
warns on first run — that needs a certificate), and it targets Windows x64 only.
The macOS and Linux targets need `icon.icns` / the Linux icon set, which do not
exist yet.

## Architecture

Everything that touches the network or the OS lives in the main process; the UI
is only a view of it.

```
src/main/
  main.js       app lifecycle, windows, menus, IPC gateway (the security boundary)
  tabs.js       tab model: view creation, activation, layout, find-in-page, panel view
  sessions.js   per-window partitions, the verity:// protocol, permissions, downloads
  privacy.js    request filtering, HTTPS upgrade, headers, cookies, fingerprint surface
  blocklist.js  rule parsing and hostname-boundary matching
  settings.js   typed settings store with per-site exceptions
  search.js     omnibox input resolution
src/preload/
  chrome.js     the privileged bridge — only verity://chrome and verity://panel get it
  page.js       the narrow bridge for verity:// pages (new tab, blocked page)
src/renderer/
  chrome.html   tab strip, toolbar, omnibox, find bar, bookmarks bar
  panel.html    the side panel: shield, settings, bookmarks, menu
  newtab / blocked / about
```

### Two view-level facts worth knowing

**The side panel is its own `WebContentsView`, not an element of the chrome
document.** Chromium composites the chrome document *under* the page views and
never rasterises chrome pixels in a region a view has covered, so a drawer drawn
there stays blank. A view renders as reliably as a page does. The panel floats
above the page, and the page therefore always keeps the full window width.

**A child view does not always resolve through `BrowserWindow.fromWebContents`.**
The IPC gateway resolves a sender by view identity *and* origin, with an explicit
identity fallback for the panel, so exactly two documents can drive a window:
`verity://chrome` and `verity://panel`. A web page never gets a bridge at all.

**The strip height is measured on demand, not only on resize.** The page surface
starts where the chrome strip ends, so a stale height lays the page out against the
wrong offset. A `ResizeObserver` only delivers with a rendered frame, which a window
the compositor is not drawing never gets, so every bar that appears or disappears —
and every command from main — triggers an explicit measurement as well.

## Verification

Two suites, because they can prove different things.

| Command | What it covers |
| --- | --- |
| `npm run smoke` | 39 headless checks: rule engine, omnibox resolution, session isolation, actual request filtering against a local fixture server, cookie and header handling, HTTPS-only and its exceptions, tab lifecycle, the error interstitial, every panel's DOM driven through its own view, the mascot everywhere it is meant to appear (strip, new tab, panel header, app icon), the panel following a live theme change, and the profile argument resolving to a directory it cannot be tricked out of. |
| `npm run diagnose` | 5 checks against a real, visible, composited window: strip geometry, palette resolution, panel view placement, and `findInPage` with real match counts. |
| `npm run capture` | Writes screenshots to `artifacts/` for human review. |

Run them together with `npm run verify`.

### Known limits of the automated runs

- `findInPage` returns nothing to a software-composited window that never
  composited. `npm run smoke` reports that check as an explicit **skip**, and
  `npm run diagnose` verifies the same flow against a real window instead. It is
  never counted as a pass.
- The OS window thumbnail contains no child-view pixels, and on this desktop a
desktop capture photographs whatever is on top of Verity, so the panel's own
  pixels can be unavailable. The panel is then verified by view geometry,
  visibility and DOM content against a real window, plus the mechanism the page
  surface already proves; `npm run capture` says so explicitly instead of writing a
  blank image and calling it evidence.
- The built-in filter list is a curated set of ad, tracker, analytics,
  fingerprinting, cryptomining and social domains, not a full EasyList. A custom
  hosts-format list can be loaded from Settings on demand.

## Settings

`settings.json` in the app's user-data directory stores only preferences —
never browsing data. Every protective option defaults to on:

```
ephemeralMode  clearOnExit  httpsOnly  blockAdsTrackers
blockThirdPartyCookies  blockThirdPartyStorage  stripTrackingParams
reduceFingerprinting  sendDoNotTrack  denyPermissionsByDefault
```

Plus `homepage`, `searchEngine`, `theme` (`dark` by default, or `light` /
`system`), `showBookmarksBar`, per-site `siteExceptions`, and an optional
`customBlocklistUrl`.

## Shortcuts

`Ctrl/Cmd+T` new tab · `Ctrl/Cmd+W` close tab · `Ctrl/Cmd+Shift+T` reopen closed
tab · `Ctrl/Cmd+L` focus address bar · `Ctrl/Cmd+F` find · `F3` find next ·
`Ctrl+Tab` next tab · `Ctrl/Cmd+R` reload · `Ctrl/Cmd+Shift+Y` shield ·
`Ctrl/Cmd+Shift+O` bookmarks · `Ctrl/Cmd+,` settings · `Ctrl/Cmd+Shift+Del` clear
browsing data.

## Not built (yet)

No extensions, no sync, no profiles beyond per-window partitions, no persistent
history or downloads manager UI, and no automatic filter-list updates.
