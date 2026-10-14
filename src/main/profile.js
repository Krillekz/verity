'use strict';

/**
 * Named profiles.
 *
 * Verity keeps everything it owns — settings, bookmarks, per-site exceptions —
 * in one directory. With `--profile=name` an instance keeps its own, so you can
 * run two copies side by side without them sharing a thing, on this desktop or a
 * virtual one.
 *
 * Note what a profile does and does not separate: with ephemeral mode on (the
 * default) no browsing data is written anywhere, so a profile is mostly about
 * *settings*. It matters most for someone who has turned ephemeral mode off.
 *
 * The parsing and path rules are pure functions so they can be tested directly;
 * main.js is the only caller.
 */

const path = require('path');

/** A bare profile name: no separators, no drive letters, nothing to traverse with. */
const NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** The value that means "the normal directory", written the way a user would. */
const DEFAULT_NAME = 'default';

/**
 * Read a profile request out of a command line.
 *
 * Accepts both `--profile=name` and `--profile name`, because a shortcut on
 * Windows makes the second form much easier to hand-edit.
 *
 * @returns {string|null} the raw value, or null when no profile was asked for
 */
function profileArg(argv) {
  const args = Array.isArray(argv) ? argv : [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    if (arg.startsWith('--profile=')) return arg.slice('--profile='.length);
    if (arg === '--profile') {
      const next = args[index + 1];
      return next === undefined ? '' : String(next);
    }
  }
  return null;
}

/**
 * Turn a profile value into a directory, or null to use the normal one.
 *
 * A bare name lives under the app's data directory, where it is easy to find and
 * to delete; an absolute path is honoured as given, so a profile can live on
 * another drive. Anything containing a path separator other than an absolute
 * path is refused rather than guessed at.
 *
 * @param {string|null} value  the raw value from the command line
 * @param {{appDataDir: string}} options
 * @returns {string|null}
 */
function resolveProfilePath(value, { appDataDir } = {}) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw || raw === DEFAULT_NAME) return null;
  if (path.isAbsolute(raw)) return path.normalize(raw);
  if (!NAME_PATTERN.test(raw)) return null;
  if (!appDataDir) return null;
  return path.join(appDataDir, 'Verity', 'profiles', raw);
}

/** What the UI calls this instance's data directory. */
function profileLabel(value, resolvedPath) {
  if (!resolvedPath) return DEFAULT_NAME;
  return path.basename(resolvedPath) || String(value || DEFAULT_NAME);
}

module.exports = { profileArg, resolveProfilePath, profileLabel, DEFAULT_NAME };
