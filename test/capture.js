'use strict';

/**
 * Visual review run (`npm run capture`).
 *
 * Opens a real, visible Verity window, waits for it to paint, and writes PNGs to
 * artifacts/ so a human can check the UI.
 *
 * Four paths, because each shows something the others cannot:
 *   - the OS window thumbnail (`-window`) covers the chrome strip, and nothing a
 *     child view draws: the page and the panel are absent from it;
 *   - region crops are cut from that thumbnail, so they are exact for the strip
 *     and blank anywhere a view is on top;
 *   - `capturePage` on a view (`-surface`, `03-page-*`) gives that surface exactly,
 *     where the platform supports it;
 *   - a desktop capture (`-on-screen`) is the only path that can show the page and
 *     the panel together, but it photographs whatever is on top of Verity.
 *
 * Every shot is guarded, because any of these can be unavailable depending on the
 * compositor and on what else is on the desktop.
 */

const fs = require('fs');
const path = require('path');
const { desktopCapturer, screen } = require('electron');

const OUT_DIR = path.join(__dirname, '..', 'artifacts');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let lastWindowImage = null;
let contentSize = [1280, 820];

/** Reported alongside each panel shot so a stale capture is obvious. */
const PANEL_STATE = `(() => {
  const head = document.getElementById('head-title');
  return {
    title: head ? head.textContent : '',
    rows: document.querySelectorAll('#body .row').length,
    sections: document.querySelectorAll('#body > *').length,
  };
})()`;

function write(name, image) {
  fs.writeFileSync(path.join(OUT_DIR, name), image.toPNG());
  const { width, height } = image.getSize();
  console.log(`[capture] wrote ${name} (${width}x${height})`);
  return image;
}

/**
 * Best-effort shot of the whole composited window.
 *
 * The OS can hand back a frame that predates the UI's last repaint, so take a
 * fresh thumbnail on each pass and keep the last one. (Waiting on
 * requestAnimationFrame is not an option: it never fires for a window the
 * compositor has decided is not visible, which would hang this run.)
 */
async function captureWindow(name) {
  try {
    let shot = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: 1600, height: 1100 },
      });
      const source = sources.find((candidate) => candidate.name.includes('Verity'));
      if (!source) {
        console.warn(`[capture] no Verity window among: ${sources.map((s) => s.name).join(' | ')}`);
        return null;
      }
      shot = source.thumbnail;
      if (attempt < 2) await wait(400);
    }
    lastWindowImage = write(name, shot);
    return lastWindowImage;
  } catch (err) {
    console.warn(`[capture] window shot ${name} failed: ${err.message}`);
    return null;
  }
}

/** Crop a region out of the last composited window image. */
function cropFromWindow(name, rect) {
  if (!lastWindowImage) return null;
  try {
    const scale = lastWindowImage.getSize().width / Math.max(1, contentSize[0]);
    return write(
      name,
      lastWindowImage.crop({
        x: Math.max(0, Math.round(rect.x * scale)),
        y: Math.max(0, Math.round(rect.y * scale)),
        width: Math.round(rect.width * scale),
        height: Math.round(rect.height * scale),
      })
    );
  } catch (err) {
    console.warn(`[capture] crop ${name} failed: ${err.message}`);
    return null;
  }
}

/**
 * Shot of the window as the desktop actually shows it.
 *
 * The per-window thumbnail never contains child-view surfaces (page, panel), so
 * this grabs the whole screen and crops the window rectangle out of it: it is the
 * only path that can show the page and the panel together.
 *
 * It captures whatever the desktop is showing, so another window on top of Verity
 * appears instead of Verity. Read these shots as desktop context, not as proof.
 */
async function captureOnScreen(win, name) {
  try {
    const bounds = win.getBounds();
    // The window may not be on the primary display, and displays have origins.
    const display = screen.getDisplayMatching(bounds);
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: display.bounds });
    if (!sources.length) {
      console.warn('[capture] no screen source available');
      return null;
    }
    // Sources are ordered by display id; prefer the one matching our display.
    const source =
      sources.find((candidate) => String(candidate.display_id) === String(display.id)) || sources[0];
    const shot = source.thumbnail;
    const scale = shot.getSize().width / display.bounds.width;
    const cropped = shot.crop({
      x: Math.max(0, Math.round((bounds.x - display.bounds.x) * scale)),
      y: Math.max(0, Math.round((bounds.y - display.bounds.y) * scale)),
      width: Math.min(shot.getSize().width, Math.round(bounds.width * scale)),
      height: Math.min(shot.getSize().height, Math.round(bounds.height * scale)),
    });
    return write(name, cropped);
  } catch (err) {
    console.warn(`[capture] on-screen shot ${name} failed: ${err.message}`);
    return null;
  }
}

/**
 * Shot of a child view's own surface, straight from its compositor.
 *
 * This is the exact panel pixels. Neither other path can show them: the OS
 * window thumbnail omits child-view surfaces entirely, and a desktop capture is
 * a rescaled screenshot that is not pixel-stable between calls.
 */
async function captureViewSurface(view, name) {
  try {
    const image = await view.webContents.capturePage();
    if (image && !image.isEmpty()) return write(name, image);
    console.warn(`[capture] ${name}: the view returned an empty frame`);
  } catch (err) {
    console.warn(`[capture] ${name}: view surface unavailable (${err.message})`);
  }
  return null;
}

/**
 * Region shot, cropped from the live window image.
 *
 * `webContents.capturePage` is deliberately not used for these: in this
 * environment it hands back the same stale frame for every call, so two
 * different panels produced byte-identical images. The OS window thumbnail does
 * update, so crops of it are the trustworthy source.
 */
async function captureRegion(name, rect) {
  const cropped = cropFromWindow(name, rect);
  if (cropped) return cropped;
  console.warn(`[capture] no window image available for ${name}`);
  return null;
}

async function capturePageSurface(tab, name) {
  try {
    const image = await tab.webContents.capturePage();
    if (image && !image.isEmpty()) return write(name, image);
  } catch (err) {
    console.warn(`[capture] page surface shot unavailable (${err.message}); the window shots still show it`);
  }
  return null;
}

/**
 * Wait until the panel view has content before photographing it.
 *
 * The panel is its own WebContentsView (it has to be: the chrome document is
 * composited under the page views, so a drawer drawn there stays blank), so its
 * DOM is reached through its own webContents.
 */
async function waitForPanel(entry, attempt = 0) {
  const view = entry.manager.panelView;
  if (!view) {
    if (attempt > 12) {
      console.warn('[capture] the panel view was never created');
      return false;
    }
    await wait(200);
    return waitForPanel(entry, attempt + 1);
  }
  let state = 'unknown';
  try {
    state = await view.webContents.executeJavaScript(
      'document.querySelectorAll("#body > *").length > 0 ? "ready" : "empty"'
    );
  } catch {
    state = 'loading';
  }
  if (state === 'ready') return true;
  if (attempt > 12) {
    console.warn(`[capture] panel never rendered (${state})`);
    return false;
  }
  await wait(250);
  return waitForPanel(entry, attempt + 1);
}

async function runCapture({ app, createWindow, applyCommand }) {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const timeout = setTimeout(() => {
    console.error('[capture] timeout');
    app.exit(2);
  }, 120000);

  try {
    // A fresh temp profile, so these shots are the shipped defaults: the dark
    // Verity theme, whatever this desktop's own light/dark preference happens to be.
    const entry = createWindow({ url: 'verity://newtab', show: true });
    const chrome = entry.win.webContents;
    await wait(2800); // window up, page painted, fonts settled
    entry.win.focus();
    await wait(400);

    contentSize = entry.win.getContentSize();
    const [width, height] = contentSize;
    const strip = { x: 0, y: 0, width, height: 96 };
    const tab = entry.manager.active();

    await captureWindow('01-window-newtab.png');
    await captureRegion('02-chrome-strip.png', strip);
    await capturePageSurface(tab, '03-page-newtab.png');

    const openPanel = async (command, name) => {
      applyCommand(entry, command);
      const ready = await waitForPanel(entry);
      await wait(900);
      const panelWidth = entry.manager.panelWidth;
      if (!ready || panelWidth < 200) {
        console.warn(`[capture] panel "${command}" did not open (ready=${ready}, width=${panelWidth})`);
        return;
      }
      const panelState = await entry.manager.panelView.webContents.executeJavaScript(PANEL_STATE);
      console.log(`[capture] ${command} panel: ${JSON.stringify(panelState)}`);

      await captureWindow(`${name}-window.png`);
      await captureViewSurface(entry.manager.panelView, `${name}-surface.png`);
      await captureOnScreen(entry.win, `${name}-on-screen.png`);

      applyCommand(entry, command); // close
      await wait(600);
    };

    // Baseline with no panel open, for comparison by eye.
    await captureOnScreen(entry.win, '04a-panel-closed-on-screen.png');

    await openPanel('shield', '04-panel-shield');
    await wait(400);
    await openPanel('settings', '05-panel-settings');

    // Several tabs plus the bookmarks panel, for a fuller chrome shot.
    entry.manager.create({ background: true, url: 'verity://about' });
    entry.manager.create({ background: true, url: 'verity://blocked?reason=scheme&url=chrome%3A%2F%2Fsettings' });
    applyCommand(entry, 'bookmarks');
    await waitForPanel(entry);
    await wait(800);
    await captureWindow('06-window-tabs.png');
    await captureRegion('07-chrome-strip-multitab.png', strip);

    console.log('[capture] done');
    clearTimeout(timeout);
    return 0;
  } catch (err) {
    console.error('[capture] failed:', err.stack || err.message);
    clearTimeout(timeout);
    return 1;
  }
}

module.exports = { runCapture };
