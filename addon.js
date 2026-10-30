// Netflix Top 10 – Ireland: a personal Stremio catalog add-on
// Adds two rows (Films and TV) showing Netflix's official weekly Top 10 for Ireland.
// Titles are matched to IMDb IDs via Cinemeta search, so Cinemeta and Torrentio work as normal.

const { addonBuilder } = require('stremio-addon-sdk');

const COUNTRY = 'IE';                       // ISO country code (IE = Ireland, GB = UK)
const COUNTRY_NAME = 'Ireland';
const DATA_URLS = [                         // Netflix's official Top 10 data, tried in order
  'https://www.netflix.com/tudum/top10/data/all-weeks-countries.tsv',
  'https://top10.netflix.com/data/all-weeks-countries.tsv',
];
const CINEMETA = 'https://v3-cinemeta.strem.io';
const DATA_CACHE_MS = 3 * 60 * 60 * 1000;   // re-download the chart every 3 hours
const STREMIO_CACHE_SECONDS = 15 * 60;      // Stremio re-checks the rows every 15 minutes

// Manual fixes for titles that match the wrong thing: 'Exact Netflix title': 'tt1234567'
const OVERRIDES = {
  // 'Example Title': 'tt0000000',
};

const manifest = {
  id: 'local.netflixtop10ie',
  version: '1.2.0',
  name: `Netflix Top 10 ${COUNTRY_NAME}`,
  description: `Netflix's official weekly Top 10 for ${COUNTRY_NAME}`,
  types: ['movie', 'series'],
  catalogs: [
    { type: 'movie', id: 'nftop10-films', name: `Netflix Top 10 ${COUNTRY_NAME} – Films` },
    { type: 'series', id: 'nftop10-tv', name: `Netflix Top 10 ${COUNTRY_NAME} – TV` },
  ],
  resources: ['catalog'],
};

const builder = new addonBuilder(manifest);

let chart = null;            // { t, url, week, films: [...], tv: [...] }
const lookupCache = new Map();

async function fetchChartText() {
  let lastErr;
  for (const url of DATA_URLS) {
    try {
      const res = await fetch(url);
      if (res.ok) return { url, text: await res.text() };
      lastErr = new Error(`${res.status} from ${url}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// Columns: country_name, country_iso2, week, category, weekly_rank, show_title, season_title, cumulative_weeks_in_top_10
function parseChart(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const c = line.split('\t');
    if (c[1] !== COUNTRY) continue;
    rows.push({ week: c[2], category: c[3], rank: Number(c[4]), title: c[5], weeks: Number(c[7]) });
  }
  if (!rows.length) throw new Error(`No rows for ${COUNTRY}`);
  const week = rows.reduce((max, r) => (r.week > max ? r.week : max), '');
  const latest = rows.filter(r => r.week === week).sort((a, b) => a.rank - b.rank);
  return {
    week,
    films: latest.filter(r => r.category === 'Films'),
    tv: latest.filter(r => r.category === 'TV'),
  };
}

async function getChart() {
  if (chart && Date.now() - chart.t < DATA_CACHE_MS) return chart;
  try {
    const { url, text } = await fetchChartText();
    chart = { t: Date.now(), url, ...parseChart(text) };
  } catch (e) {
    console.error('Chart download failed:', e.message);
    if (!chart) throw e;     // keep serving the last good chart if we have one
  }
  return chart;
}

const normalise = s => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');

// Find the Cinemeta entry for a Netflix title
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

function weekLabel(week) {
  // Netflix weeks run Monday–Sunday; "week" is the Sunday the week ends on
  return new Date(week + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' });
}

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
    const extra = e.weeks > 1 ? ` · ${e.weeks} weeks in Top 10` : ' · New this week';
    metas.push({
      id: m.id,
      type: metaType,
      name: `#${e.rank} ${m.name || e.title}`,     // e.g. "#1 Animals" under the poster
      poster: m.poster,
      background: m.background,
      logo: m.logo,
      releaseInfo: m.releaseInfo,
      description: `#${e.rank} in ${COUNTRY_NAME}, week ending ${weekLabel(c.week)}${extra}`,
    });
  }
  return { metas, cacheMaxAge: STREMIO_CACHE_SECONDS };
});

const addonInterface = builder.getInterface();

// Used by the /status page
addonInterface.chartStatus = async () => {
  const c = await getChart();
  return {
    source: 'Netflix official (weekly)',
    weekEnding: weekLabel(c.week),
    url: c.url,
    films: c.films.map(r => `#${r.rank} ${r.title}`),
    tv: c.tv.map(r => `#${r.rank} ${r.title}`),
  };
};

module.exports = addonInterface;
