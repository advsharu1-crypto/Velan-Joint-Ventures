#!/usr/bin/env node
/* Dev-time helper: renders every built page in a headless browser and saves the page-specific JSON-LD
   (#viewLd, created by the page script) to tools/schema.json. tools/build.js writes it into each page's
   static HTML so crawlers that do not run JavaScript still see FAQs, breadcrumbs and services.
   Run after content changes:  node tools/build.js && node tools/gen-schema.js && node tools/build.js
   (needs Playwright and a static server on dist/, see PORT). */
const fs = require('fs'), path = require('path'), http = require('http');
const { chromium } = require('playwright');
const OUT = path.join(__dirname, '..', 'dist'), PORT = 8124;
const types = { '.html': 'text/html', '.xml': 'text/xml', '.txt': 'text/plain', '.jpg': 'image/jpeg', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const srv = http.createServer((q, r) => {
  let p = decodeURIComponent(q.url.split('?')[0]); let f = path.join(OUT, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = fs.existsSync(path.join(f, 'index.html')) ? path.join(f, 'index.html') : path.join(OUT, p.replace(/\/$/, ''), 'index.html');
  if (!fs.existsSync(f)) { r.statusCode = 404; return r.end(); }
  r.setHeader('Content-Type', types[path.extname(f)] || 'application/octet-stream'); r.end(fs.readFileSync(f));
}).listen(PORT, async () => {
  const urls = [...fs.readFileSync(path.join(OUT, 'sitemap.xml'), 'utf8').matchAll(/<loc>https:\/\/[^/]+(\/[^<]*)<\/loc>/g)].map(m => m[1]);
  const b = await chromium.launch(), pg = await b.newPage(), res = {};
  for (const u of urls) {
    await pg.goto('http://localhost:' + PORT + u, { waitUntil: 'load' }); await pg.waitForTimeout(1500);
    const j = await pg.evaluate(() => { const e = document.getElementById('viewLd'); return e ? e.textContent : ''; });
    if (j) res[u] = JSON.parse(j);
  }
  await b.close(); srv.close();
  fs.writeFileSync(path.join(__dirname, 'schema.json'), JSON.stringify(res));
  console.log('schema for', Object.keys(res).length, 'of', urls.length, 'pages');
});
