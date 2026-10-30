// Web server for the add-on. Vercel runs this file automatically.
// To test on your own PC instead: npm install, then node server.js
const express = require('express');
const { getRouter } = require('stremio-addon-sdk');
const addonInterface = require('./addon');

const app = express();

// Open /status in a browser to see which week is loaded
app.get('/status', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    res.json(await addonInterface.chartStatus());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.use(getRouter(addonInterface));

module.exports = app;

if (require.main === module) {
  app.listen(7000, () => console.log('http://127.0.0.1:7000/manifest.json'));
}
