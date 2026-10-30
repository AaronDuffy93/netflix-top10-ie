// Netflix Top 10 – Ireland: a personal Stremio catalog add-on
// Adds two rows (Films and TV) showing the Netflix Top 10 for Ireland.
//
// Source 1: FlixPatrol's daily Top 10 page for Ireland (unofficial, read from the web page).
// Source 2 (fallback): Netflix's official weekly Top 10 data, used if FlixPatrol can't be read.
// The chart is refreshed twice a day (see REFRESH_HOURS). Titles are matched to IMDb IDs via
// Cinemeta search, so Cinemeta and Torrentio work on them as normal.

const { addonBuilder } = require('stremio-addon-sdk');

const COUNTRY = 'IE';                       // ISO country code for the weekly fallback
const COUNTRY_NAME = 'Ireland';
const FLIXPATROL_SLUG = 'ireland';          // as in flixpatrol.com/top10/netflix/ireland
const TIME_ZONE = 'Europe/Dublin';
const REFRESH_HOURS = [8, 16];              // refresh at 08:00 and 16:00 Irish time
                                            // (FlixPatrol publishes new results after 15:00)
const WEEKLY_URLS = [                       // Netflix's official weekly data, tried in order
  'https://www.netflix.com/tudum/top10/data/all-weeks-countries.tsv',
  'https://top10.netflix.com/data/all-weeks-countries.tsv',
];
const CINEMETA = 'https://v3-cinemeta.strem.io';
const STREMIO_CACHE_SECONDS = 15 * 60;      // Stremio re-checks the rows every 15 minutes
const FALLBACK_RETRY_MS = 30 * 60 * 1000;   // if on the weekly fallback, retry FlixPatrol every 30 minutes
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-GB,en;q=0.9',
};

// Manual fixes for titles that match the wrong thing: 'Exact chart title': 'tt1234567'
const OVERRIDES = {
  // 'Example Title': 'tt0000000',
};

const manifest = {
  id: 'local.netflixtop10ie',
  version: '1.1.1',
  name: `Netflix Top 10 ${COUNTRY_NAME}`,
  description: `Netflix Top 10 for ${COUNTRY_NAME} – daily from FlixPatrol, with Netflix's official weekly chart as a fallback`,
  types: ['movie', 'series'],
  catalogs: [
    { type: 'movie', id: 'nftop10-films', name: `Netflix Top 10 ${COUNTRY_NAME} – Films` },
    { type: 'series', id: 'nftop10-tv', name: `Netflix Top 10 ${COUNTRY_NAME} – TV` },
  ],
  resources: ['catalog'],
};

const builder = new addonBuilder(manifest);

// ---------- Twice-a-day schedule ----------

// Irish local date/time parts for a moment in time
function dublinParts(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, s: +p.second };
}

// UTC time of a given Irish local date + hour
function dublinTime(y, m, d, h) {
  const guess = Date.UTC(y, m - 1, d, h);
  const p = dublinParts(new Date(guess));
  const offset = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - guess; // Irish offset from UTC
  return guess - offset;
}

const isoDate = ms => { const p = dublinParts(new Date(ms)); return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; };

// Current refresh period: when it started and when the next one begins
function currentSlot(now = Date.now()) {
  const p = dublinParts(new Date(now));
  const times = [];
  for (const dayShift of [-1, 0, 1]) {
    const base = Date.UTC(p.y, p.m - 1, p.d + dayShift);
    const b = new Date(base);
    for (const h of REFRESH_HOURS) times.push(dublinTime(b.getUTCFullYear(), b.getUTCMonth() + 1, b.getUTCDate(), h));
  }
  times.sort((a, b) => a - b);
  const start = Math.max(...times.filter(t => t <= now));
  const next = Math.min(...times.filter(t => t > now));
  return { start, next };
}

// ---------- Source 1: FlixPatrol daily page ----------

function decodeHtml(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}
const stripTags = s => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

// Title links between two positions in the page, in order, first 10 unique
function titlesBetween(html, start, end) {
  const re = /<a\b[^>]*href="(?:https?:\/\/(?:www\.)?flixpatrol\.com)?\/title\/([^"\/?#]+)\/?"[^>]*>([\s\S]*?)<\/a>/gi;
  re.lastIndex = start;
  const seen = new Set();
  const out = [];
  let m;
  while ((m = re.exec(html)) && m.index < end && out.length < 10) {
    const title = decodeHtml(stripTags(m[2]));
    if (!title || seen.has(m[1])) continue;     // skip poster-only links and repeats
    seen.add(m[1]);
    out.push({ rank: out.length + 1, title });
  }
  return out;
}

// Find a "TOP 10 Movies" / "TOP 10 TV Shows" heading followed by at least 5 titles
function section(html, heading, otherHeadings) {
  const re = new RegExp(heading.source, 'gi');
  let m;
  while ((m = re.exec(html))) {
    const start = m.index + m[0].length;
    let end = start + 80000;
    for (const other of [heading, ...otherHeadings]) {
      const o = new RegExp(other.source, 'gi');
      o.lastIndex = start;
      const hit = o.exec(html);
      if (hit && hit.index < end) end = hit.index;
    }
    const titles = titlesBetween(html, start, end);
    if (titles.length >= 5) return titles;
  }
  return [];
}

const MOVIES_HEADING = /top\s*10(?:\s|<[^>]*>)*movies/;
const TV_HEADING = /top\s*10(?:\s|<[^>]*>)*tv(?:\s|<[^>]*>)*shows/;

function parseFlixPatrol(html) {
  return {
    films: section(html, MOVIES_HEADING, [TV_HEADING]),
    tv: section(html, TV_HEADING, [MOVIES_HEADING]),
  };
}

async function fetchFlixPatrol() {
  const today = Date.now();
  const tries = [
    { date: isoDate(today), url: `https://flixpatrol.com/top10/netflix/${FLIXPATROL_SLUG}/${isoDate(today)}/` },
    { date: isoDate(today - 86400000), url: `https://flixpatrol.com/top10/netflix/${FLIXPATROL_SLUG}/${isoDate(today - 86400000)}/` },
    { date: null, url: `https://flixpatrol.com/top10/netflix/${FLIXPATROL_SLUG}/` },
  ];
  const problems = [];
  for (const t of tries) {
    try {
      const res = await fetch(t.url, { headers: BROWSER_HEADERS });
      if (!res.ok) { problems.push(`${res.status} from ${t.url}`); continue; }
      const { films, tv } = parseFlixPatrol(await res.text());
      if (films.length >= 5 && tv.length >= 5) {
        return { source: 'flixpatrol', label: t.date ? `daily chart for ${longDate(t.date)}` : 'daily chart', url: t.url, films, tv };
      }
      problems.push(`couldn't find the Top 10 lists on ${t.url}`);
    } catch (e) {
      problems.push(`${e.message} for ${t.url}`);
    }
  }
  throw new Error('FlixPatrol: ' + problems.join('; '));
}

// ---------- Source 2: Netflix official weekly data ----------

async function fetchWeekly() {
  let lastErr;
  for (const url of WEEKLY_URLS) {
    try {
      const res = await fetch(url);
      if (!res.ok) { lastErr = new Error(`${res.status} from ${url}`); continue; }
      // Columns: country_name, country_iso2, week, category, weekly_rank, show_title, season_title, cumulative_weeks_in_top_10
      const rows = [];
      for (const line of (await res.text()).split('\n')) {
        const c = line.split('\t');
        if (c[1] === COUNTRY) rows.push({ week: c[2], category: c[3], rank: Number(c[4]), title: c[5], weeks: Number(c[7]) });
      }
      if (!rows.length) throw new Error(`No rows for ${COUNTRY}`);
      const week = rows.reduce((max, r) => (r.week > max ? r.week : max), '');
      const latest = rows.filter(r => r.week === week).sort((a, b) => a.rank - b.rank);
      const withNote = r => ({ rank: r.rank, title: r.title, note: r.weeks > 1 ? `${r.weeks} weeks in Top 10` : 'New this week' });
      return {
        source: 'netflix-weekly',
        label: `weekly chart, week ending ${longDate(week)}`,
        url,
        films: latest.filter(r => r.category === 'Films').map(withNote),
        tv: latest.filter(r => r.category === 'TV').map(withNote),
      };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// ---------- Chart cache ----------

let chart = null;   // { slotStart, fetchedAt, source, label, url, films, tv, fallbackReason? }

const isFresh = c => c && c.slotStart === currentSlot().start
  && (c.source === 'flixpatrol' || Date.now() - c.fetchedAt < FALLBACK_RETRY_MS);

async function getChart() {
  if (isFresh(chart)) return chart;
  const start = currentSlot().start;
  try {
    chart = { slotStart: start, fetchedAt: Date.now(), ...(await fetchFlixPatrol()) };
  } catch (e) {
    console.error(e.message);
    try {
      chart = { slotStart: start, fetchedAt: Date.now(), ...(await fetchWeekly()), fallbackReason: e.message };
    } catch (e2) {
      console.error('Weekly fallback failed:', e2.message);
      if (!chart) throw e2;                 // keep serving the last good chart if we have one
    }
  }
  return chart;
}

// ---------- Matching titles to IMDb ----------

const lookupCache = new Map();
const normalise = s => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');

async function lookup(title, type) {
  if (OVERRIDES[title]) return { id: OVERRIDES[title] };
  const key = type + '|' + title;
  if (lookupCache.has(key)) return lookupCache.get(key);
  let match = null;
  try {
    const res = await fetch(`${CINEMETA}/catalog/${type}/top/search=${encodeURIComponent(title)}.json`);
    const { metas = [] } = res.ok ? await res.json() : {};
    match = metas.find(m => normalise(m.name || '') === normalise(title)) || metas[0] || null;
  } catch (e) {
    console.error(`Lookup failed for ${title}:`, e.message);
  }
  if (match) lookupCache.set(key, match);
  return match;
}

function longDate(iso) {
  return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' });
}

// ---------- Stremio catalogs ----------

builder.defineCatalogHandler(async ({ id }) => {
  if (id !== 'nftop10-films' && id !== 'nftop10-tv') return { metas: [] };
  const c = await getChart();
  const entries = id === 'nftop10-films' ? c.films : c.tv;
  const metaType = id === 'nftop10-films' ? 'movie' : 'series';

  const found = await Promise.all(entries.map(async e => ({ e, m: await lookup(e.title, metaType) })));
  const seen = new Set();
  const metas = [];
  for (const { e, m } of found) {
    if (!m || !m.id || seen.has(m.id)) continue;   // skip unmatched titles and repeat seasons
    seen.add(m.id);
    metas.push({
      id: m.id,
      type: metaType,
      name: `#${e.rank} ${m.name || e.title}`,     // e.g. "#1 Wicked" under the poster
      poster: m.poster,
      background: m.background,
      logo: m.logo,
      releaseInfo: m.releaseInfo,
      description: `#${e.rank} in ${COUNTRY_NAME} – ${c.label}${e.note ? ' · ' + e.note : ''}`,
    });
  }
  return { metas, cacheMaxAge: STREMIO_CACHE_SECONDS, staleError: 24 * 60 * 60 };
});

const addonInterface = builder.getInterface();

// Used by the /status page
addonInterface.chartStatus = async () => {
  const c = await getChart();
  return {
    source: c.source === 'flixpatrol' ? 'FlixPatrol (daily)' : 'Netflix official (weekly fallback)',
    chart: c.label,
    url: c.url,
    whyFallback: c.fallbackReason,
    nextRefresh: new Date(currentSlot().next).toLocaleString('en-GB', { timeZone: TIME_ZONE }),
    films: c.films.map(r => `#${r.rank} ${r.title}`),
    tv: c.tv.map(r => `#${r.rank} ${r.title}`),
  };
};

// How long Vercel's cache may keep a row (see server.js):
// until the next refresh time for the daily chart, 30 minutes while on the weekly fallback
addonInterface.cdnSeconds = () => {
  const toNext = Math.round((currentSlot().next - Date.now()) / 1000);
  const limit = chart && chart.source === 'flixpatrol' ? toNext : FALLBACK_RETRY_MS / 1000;
  return Math.max(60, Math.min(toNext, limit));
};

// Exposed for testing
addonInterface._test = { parseFlixPatrol, currentSlot, isoDate };

module.exports = addonInterface;
