#!/usr/bin/env node
/*
 * Velan Joint Ventures: static build.
 * index.html is the single source. This script writes ./dist with
 *   - one HTML file per page address (e.g. dist/about/index.html) that has its own
 *     <title>, description, canonical, Open Graph tags and robots directive,
 *   - real <a href="/path"> links in place of '#view' links (outside <script>),
 *   - sitemap.xml listing every indexable page,
 *   - copies of the static assets (favicons, images, robots.txt, verification file).
 * Run:  node tools/build.js            (build)
 *       node tools/build.js --write-config   (regenerate vercel.json rewrites)
 * The path rule must match viewPath() in index.html.
 */
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..'), OUT = path.join(ROOT, 'dist');
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const attr = (tag, name) => { const m = tag.match(new RegExp('\\s' + name + '="([^"]*)"')); return m ? m[1] : null; };
const viewPath = (id, isHome) => isHome ? '/' : '/' + id.replace(/-view$/, '').replace(/^blog-/, 'blog/').replace(/^industry-/, 'industry/');

const headEnd = SRC.indexOf('</head>');
const HEAD = SRC.slice(0, headEnd);
const siteM = HEAD.match(/<link rel="canonical" href="(https:\/\/[^"]+?)\/?"[^>]*>/);
if (!siteM) throw new Error('canonical link with an https address not found in <head>');
const SITE = siteM[1].replace(/\/+$/, '');

/* views */
const views = [];
for (const m of SRC.matchAll(/<main\b[^>]*>/g)) {
  const tag = m[0]; const name = attr(tag, 'data-view'); if (!name) continue;
  const id = attr(tag, 'id'); const isHome = name === 'home';
  views.push({ tag, name, id, isHome, path: viewPath(id, isHome), title: attr(tag, 'data-title'), desc: attr(tag, 'data-desc') });
}
const noindexM = SRC.match(/const NOINDEX_VIEWS=\[([^\]]*)\]/);
const NOINDEX = new Set(noindexM ? [...noindexM[1].matchAll(/'([^']+)'/g)].map(x => x[1]) : []);
/* utility page kept crawlable but not advertised in the sitemap */
const NOT_IN_SITEMAP = new Set(['support']);
const seen = new Set();
for (const v of views) { if (seen.has(v.path)) throw new Error('duplicate path ' + v.path); seen.add(v.path); if (!v.isHome && (!v.title || !v.desc)) throw new Error('missing data-title/data-desc on ' + v.id); }
const home = views.find(v => v.isHome);
const rootIds = new Set(views.filter(v => !v.isHome).map(v => v.id));
const idToPath = Object.fromEntries(views.map(v => [v.id, v.path]));

/* Convert '#xxx-view' anchors to real links, outside <script> blocks */
const NOCONV = /\s(data-book|data-goal|data-open|data-open-prefs)(\s|=|>)|class="[^"]*\bskip\b[^"]*"/;
function convertLinks(html) {
  return html.split(/(<script\b[\s\S]*?<\/script>)/i).map(part => {
    if (/^<script/i.test(part)) return part;
    part = part.replace(/<a\b[^>]*>/g, tag => {
      if (NOCONV.test(tag)) return tag;
      return tag.replace(/href="#([^"]+)"/, (m, id) => rootIds.has(id) ? 'href="' + idToPath[id] + '"' : m);
    });
    part = part.replace(/<nav class="crumbs"[\s\S]*?<\/nav>/g, nav => nav.replace(/href="#home"/g, 'href="/"'));
    return part;
  }).join('');
}
const BASE_HTML = convertLinks(SRC);

const setMeta = (h, re, val) => { if (!re.test(h)) throw new Error('tag not found: ' + re); return h.replace(re, (m, a, b) => a + val + b); };
function pageFor(v) {
  if (v.isHome) return BASE_HTML;
  const he = BASE_HTML.indexOf('</head>');
  let h = BASE_HTML.slice(0, he), rest = BASE_HTML.slice(he);
  const url = SITE + v.path;
  h = h.replace(/<title>[^<]*<\/title>/, '<title>' + v.title + '</title>');
  h = setMeta(h, /(<meta name="description" content=")[^"]*(")/, v.desc);
  h = setMeta(h, /(<meta property="og:title" content=")[^"]*(")/, v.title);
  h = setMeta(h, /(<meta property="og:description" content=")[^"]*(")/, v.desc);
  h = setMeta(h, /(<meta name="twitter:title" content=")[^"]*(")/, v.title);
  h = setMeta(h, /(<meta name="twitter:description" content=")[^"]*(")/, v.desc);
  h = setMeta(h, /(<link rel="canonical" href=")[^"]*(")/, url);
  h = setMeta(h, /(<meta property="og:url" content=")[^"]*(")/, url);
  if (NOINDEX.has(v.name)) {
    h = setMeta(h, /(<meta name="robots" content=")[^"]*(")/, 'noindex, follow');
    h = setMeta(h, /(<meta name="googlebot" content=")[^"]*(")/, 'noindex, follow');
  }
  /* show this page (not the home page) in the static HTML so it reads correctly without JavaScript */
  const mains = [...rest.matchAll(/<main\b[^>]*>/g)].map(m => m[0]);
  const flip = (tag, hide) => { const t = tag.replace(/\shidden(?=[\s>=])(="[^"]*")?/, ''); return hide ? t.replace(/>$/, ' hidden>') : t; };
  const homeTag = mains.find(t => attr(t, 'data-view') === 'home');
  const thisTag = mains.find(t => attr(t, 'id') === v.id);
  rest = rest.replace(homeTag, flip(homeTag, true)).replace(thisTag, flip(thisTag, false));
  return h + rest;
}

const urls = views.filter(v => v.isHome || (!NOINDEX.has(v.name) && !NOT_IN_SITEMAP.has(v.name))).map(v => SITE + v.path);
const sitemap = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + urls.map(u => '  <url>\n    <loc>' + u + '</loc>\n  </url>').join('\n') + '\n</urlset>\n';

if (process.argv.includes('--write-config')) {
  const cfgPath = path.join(ROOT, 'vercel.json');
  const cfg = { buildCommand: 'node tools/build.js', outputDirectory: 'dist', cleanUrls: false, trailingSlash: false,
    rewrites: views.filter(v => !v.isHome).map(v => ({ source: v.path, destination: v.path + '/index.html' })) };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  console.log('wrote vercel.json with', cfg.rewrites.length, 'rewrites'); process.exit(0);
}

fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
for (const v of views) {
  const file = v.isHome ? path.join(OUT, 'index.html') : path.join(OUT, v.path.slice(1), 'index.html');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, pageFor(v));
}
fs.writeFileSync(path.join(OUT, 'sitemap.xml'), sitemap);
const SKIP = new Set(['.git', '.gitignore', 'dist', 'tools', 'node_modules', 'vercel.json', 'index.html', 'sitemap.xml', 'README.md', 'package.json']);
for (const f of fs.readdirSync(ROOT)) { if (SKIP.has(f)) continue; const p = path.join(ROOT, f); if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(OUT, f)); }

/* consistency check against vercel.json (warn only) */
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const have = new Set((cfg.rewrites || []).map(r => r.source));
  const missing = views.filter(v => !v.isHome && !have.has(v.path)).map(v => v.path);
  if (missing.length) console.warn('WARNING: vercel.json is missing rewrites for', missing.join(', '), '- run: node tools/build.js --write-config');
} catch (e) { console.warn('WARNING: could not check vercel.json:', e.message); }
console.log('built ' + views.length + ' pages; sitemap has ' + urls.length + ' URLs; ' + NOINDEX.size + ' noindex pages excluded' );
