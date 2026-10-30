// Web server for the add-on. Vercel runs this file automatically.
// To test on your own PC instead: npm install, then node server.js
const express = require('express');
const { getRouter } = require('stremio-addon-sdk');
const addonInterface = require('./addon');

const app = express();

// Open /status in a browser to see which source and chart are loaded
app.get('/status', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    res.json(await addonInterface.chartStatus());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Let Vercel's cache keep each row until the next refresh time, so FlixPatrol
// is only read about twice a day instead of every time Stremio asks.
app.use('/catalog', (req, res, next) => {
  const setHeader = res.setHeader.bind(res);
  res.setHeader = (name, value) => {
    if (String(name).toLowerCase() === 'cache-control') {
      const m = /max-age=(\d+)/.exec(String(value));
      if (m) value = `${value}, s-maxage=${m[1]}`;
    }
    return setHeader(name, value);
  };
  next();
});

app.use(getRouter(addonInterface));

module.exports = app;

if (require.main === module) {
  app.listen(7000, () => console.log('http://127.0.0.1:7000/manifest.json'));
}
