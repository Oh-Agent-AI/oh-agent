// Notify IndexNow (Bing, Yandex, Naver, Seznam…) about every URL in the staged sitemaps.
// Usage: node tools/indexnow.mjs <stageDir>. The key file <key>.txt must be at the site root.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const stage = process.argv[2];
const host = 'ohagent.ai';
const keyFile = readdirSync(stage).find((f) => /^[a-zA-Z0-9-]{8,128}\.txt$/.test(f) && f !== 'llms.txt' && f !== 'robots.txt' && f !== 'llms-full.txt');
if (!keyFile) { console.log('indexnow: no key file staged, skipping'); process.exit(0); }
const key = readFileSync(join(stage, keyFile), 'utf8').trim();
const maps = [join(stage, 'sitemap.xml'), ...readdirSync(join(stage, 'docs')).filter((f) => /^sitemap-\d+\.xml$/.test(f)).map((f) => join(stage, 'docs', f))];
const urls = [...new Set(maps.flatMap((m) => [...readFileSync(m, 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map((x) => x[1].trim())))]
  .filter((u) => new URL(u).host === host);
const res = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ host, key, keyLocation: `https://${host}/${keyFile}`, urlList: urls }),
});
console.log(`indexnow: submitted ${urls.length} URLs -> HTTP ${res.status}`);
