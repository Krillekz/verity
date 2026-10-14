'use strict';

/**
 * Verity's built-in filter list.
 *
 * Patterns are registrable domains matched on a *hostname suffix* boundary, so
 * `doubleclick.net` also covers `ad.doubleclick.net` but never `notdoubleclick.net`.
 * Sections are separated by `# <category>` comments.
 *
 * The list is intentionally curated (high-confidence ad, tracking, fingerprinting
 * and cryptomining hosts) so that normal sites keep working out of the box. Users
 * can extend it with their own hosts-format list via the custom list URL.
 */
const RAW_LIST = `
# ads
doubleclick.net
googleadservices.com
googlesyndication.com
googleads.g.doubleclick.net
adservice.google.com
pagead2.googlesyndication.com
2mdn.net
adnxs.com
adsrvr.org
adform.net
adroll.com
adsafeprotected.com
amazon-adsystem.com
applovin.com
casalemedia.com
chartboost.com
contextweb.com
criteo.com
criteo.net
demdex.net
dotomi.com
doubleverify.com
everesttech.net
exelator.com
flashtalking.com
inmobi.com
integralads.com
krxd.net
lijit.com
liveintent.com
mathtag.com
media.net
moatads.com
mopub.com
openx.net
outbrain.com
pubmatic.com
quantserve.com
quantcount.com
rubiconproject.com
serving-sys.com
sharethrough.com
simpli.fi
smartadserver.com
spotxchange.com
taboola.com
teads.tv
tribalfusion.com
turn.com
yieldmo.com
zedo.com
33across.com
agkn.com
bidswitch.net
bluekai.com
crazyegg.com
ads-twitter.com
advertising.com
atwola.com
yieldmanager.com
zedo.com
smartclip.net
yieldlab.net
adtech.de
adition.com
improvedigital.com
districtm.io
sovrn.com
smaato.net
yieldoptimizer.com
advertising.yahoo.com
adserver.yahoo.com
gemini.yahoo.com
ad.doubleclick.net
securepubads.g.doubleclick.net
stats.g.doubleclick.net

# analytics
google-analytics.com
analytics.google.com
googletagmanager.com
googletagservices.com
amplitude.com
api.amplitude.com
heapanalytics.com
hotjar.com
hotjar.io
inspectlet.com
kissmetrics.com
matomo.cloud
mixpanel.com
mouseflow.com
newrelic.com
nr-data.net
optimizely.com
parsely.com
pingdom.net
plausible.io
qualtrics.com
segment.com
segment.io
statcounter.com
smartlook.com
usabilla.com
webtrendslive.com
appsflyer.com
branch.io
adjust.com
kochava.com
singular.net
mparticle.com
tealiumiq.com
ensighten.com
krxd.net
boomtrain.com
cxense.com
narrative.io
liveramp.com
tapad.com
adsymptotic.com
rlcdn.com
crwdcntrl.net
ml314.com
addthis.com
sharethis.com
onesignal.com
pushengage.com
clevertap.com
moengage.com
webengage.com
hs-analytics.net
hs-scripts.com
hsforms.net
pardot.com
marketo.com
mktoresp.com
eloqua.com
marketingcloudapis.com
omtrdc.net
2o7.net
sc.omtrdc.net

# fingerprinting
fingerprintjs.com
fpjs.io
fpapi.io

# session-recording
fullstory.com
logrocket.io
logrocket.com
lr-ingest.io
lr-in.com
clicktale.net
luckyorange.com
quantummetric.com
sessioncam.com
decibelinsight.net
posthog.com
contentsquare.net
userzoom.com

# social
connect.facebook.net
pixel.facebook.com
graph.facebook.com
analytics.tiktok.com
business-api.tiktok.com
ads.tiktok.com
tr.snapchat.com
analytics.twitter.com
t.co/i/adsct
ads.linkedin.com
px.ads.linkedin.com
platform.linkedin.com
pinimg.com/ct
ct.pinterest.com
analytics.pinterest.com
widgets.pinterest.com
mc.yandex.ru
metrika.yandex.ru
counter.yadro.ru

# cryptomining
coinhive.com
coin-hive.com
authedmine.com
crypto-loot.com
coinimp.net
jsecoin.com
webmine.cz
minero.cc
`;

/** Parses a `# category` sectioned list into normalised entries. */
function parseList(text) {
  const entries = [];
  let category = 'ads';
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const name = line.replace(/^#+\s*/, '').split(/\s+/)[0].toLowerCase().replace(/[^a-z-]/g, '');
      if (name) category = name;
      continue;
    }
    if (line.startsWith('!')) continue; // EasyList-style comment
    const domain = normalisePattern(line);
    if (domain) entries.push({ domain, category });
  }
  return entries;
}

/**
 * Accepts both bare domains (`ads.example.com`) and hosts-file lines
 * (`0.0.0.0 ads.example.com`, `127.0.0.1 ads.example.com # comment`).
 */
function normalisePattern(line) {
  let value = line.split('#')[0].trim();
  if (!value) return null;
  const parts = value.split(/\s+/);
  if (parts.length > 1 && /^(0\.0\.0\.0|127\.0\.0\.1|::1?)$/.test(parts[0])) value = parts[1];
  else value = parts[0];

  value = value
    .toLowerCase()
    .replace(/^\|+/, '')
    .replace(/\|+$/, '')
    .replace(/^\*\./, '')
    .replace(/^\.+/, '')
    .replace(/^https?:\/\//, '');
  value = value.split('/')[0].split('?')[0].split(':')[0];
  if (!value || value === 'localhost' || value.length > 255) return null;
  if (!value.includes('.') && !value.endsWith('.')) return null;
  if (!/^[a-z0-9.-]+$/.test(value)) return null;
  if (/^\d/.test(value) && !/^\d+\.\d+\.\d+\.\d+$/.test(value)) return null;
  return value.replace(/\.$/, '');
}

class Blocklist {
  constructor(extraText) {
    this.byDomain = new Map();
    this.custom = 0;
    for (const entry of parseList(RAW_LIST)) this.add(entry.domain, entry.category);
    if (extraText) this.loadCustom(extraText);
  }

  get size() {
    return this.byDomain.size;
  }

  add(domain, category = 'ads') {
    if (!domain) return false;
    if (this.byDomain.has(domain)) return false;
    this.byDomain.set(domain, category);
    return true;
  }

  /** Merge a user-supplied hosts/domain list. Returns how many entries were new. */
  loadCustom(text) {
    let added = 0;
    for (const entry of parseList(text)) {
      if (this.add(entry.domain, entry.category === 'ads' ? 'custom' : entry.category)) added += 1;
    }
    this.custom += added;
    return added;
  }

  /** True (with category) when the hostname or any parent domain is listed. */
  match(hostname) {
    if (!hostname) return null;
    let host = String(hostname).toLowerCase().replace(/\.$/, '');
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
    let candidate = host;
    for (;;) {
      const category = this.byDomain.get(candidate);
      if (category) return { domain: candidate, category };
      const dot = candidate.indexOf('.');
      if (dot === -1) return null;
      candidate = candidate.slice(dot + 1);
      if (!candidate.includes('.')) {
        // Still test the final two-label form once, then stop.
        const category2 = this.byDomain.get(candidate);
        return category2 ? { domain: candidate, category: category2 } : null;
      }
    }
  }

  /** Exposed for the settings UI. */
  describe() {
    const byCategory = {};
    for (const category of this.byDomain.values()) {
      byCategory[category] = (byCategory[category] || 0) + 1;
    }
    return { total: this.byDomain.size, custom: this.custom, byCategory };
  }
}

/** Tracking query parameters stripped from outbound requests. */
const TRACKING_PARAMS = [
  /^utm_/i,
  /^ga_/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^dclid$/i,
  /^gbraid$/i,
  /^wbraid$/i,
  /^msclkid$/i,
  /^mc_eid$/i,
  /^mc_cid$/i,
  /^igshid$/i,
  /^yclid$/i,
  /^twclid$/i,
  /^ttclid$/i,
  /^_hsenc$/i,
  /^_hsmi$/i,
  /^vero_id$/i,
  /^vero_conv$/i,
  /^oly_enc_id$/i,
  /^oly_anon_id$/i,
  /^rb_clickid$/i,
  /^s_cid$/i,
  /^ref_src$/i,
  /^cmpid$/i,
  /^campaignid$/i,
  /^mkt_tok$/i,
  /^trk_/i,
];

/**
 * Remove known tracking parameters from a URL.
 * @returns {string|null} cleaned URL, or null when nothing needed to change.
 */
function stripTrackingParams(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!parsed.search) return null;
  let changed = false;
  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAMS.some((pattern) => pattern.test(key))) {
      parsed.searchParams.delete(key);
      changed = true;
    }
  }
  return changed ? parsed.toString() : null;
}

module.exports = { Blocklist, parseList, normalisePattern, stripTrackingParams, TRACKING_PARAMS, RAW_LIST };
