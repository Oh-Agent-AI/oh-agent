// Generates public/llms.txt and public/llms-full.txt from the PUBLISHED English docs
// (pages with `draft: true` are skipped). Runs before every `npm run build`.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('..', import.meta.url));
const root = join(here, 'src/content/docs');
const order = ['index', 'install', 'city-guide', 'data-sources/claude-code', 'data-sources/codex', 'privacy-and-data'];

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'zh' && dir === root ? [] : walk(p);
    return p.endsWith('.md') || p.endsWith('.mdx') ? [p] : [];
  });
}

const pages = walk(root).map((file) => {
  const text = readFileSync(file, 'utf8');
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const fm = m ? m[1] : '';
  const field = (k) => (fm.match(new RegExp(`^${k}:\\s*(.*)$`, 'm')) || [])[1]?.trim();
  const slug = relative(root, file).replace(/\.mdx?$/, '').replace(/(^|\/)index$/, '');
  return { slug, title: field('title'), description: field('description'), draft: field('draft') === 'true', body: m ? m[2] : text };
}).filter((p) => !p.draft);

const rank = (s) => { const i = order.indexOf(s === '' ? 'index' : s); return i === -1 ? 999 : i; };
pages.sort((a, b) => rank(a.slug) - rank(b.slug) || a.slug.localeCompare(b.slug));
const url = (slug) => `https://ohagent.ai/docs/${slug ? slug + '/' : ''}`;

const intro = `# Oh Agent

> Oh Agent is a free, open-source (MIT) platform for analyzing AI agent behavior data. It is built on the local-first Agent Vitals engine, which reads the session logs of Claude Code, Codex, DeepSeek Harness and WorkBuddy into a local database on your machine (no server, no upload, no account). Agent City, its first app, is a data-visualization open-world game: a 3D city where every building is one agent session.

Current release: 1.0.0-beta.3 (pre-release), https://github.com/Oh-Agent-AI/oh-agent/releases/tag/app-v1.0.0-beta.3
- macOS Apple Silicon: oh-agent-1.0.0-beta.3-arm64.dmg (Developer ID signed and notarized)
- Windows x64: oh-agent-1.0.0-beta.3-windows-x86_64-setup.exe (not code-signed yet)
- Linux x64: oh-agent-1.0.0-beta.3-linux-x86_64.deb and oh-agent-1.0.0-beta.3-linux-x86_64.AppImage (not signed yet)
- Checksums: SHA256SUMS. Intel Mac: coming later.
The web demo at https://ohagent.ai/ runs the real City frontend on synthetic sessions and does not read local data.
`;

const llms = [intro, '## Docs', ...pages.map((p) => `- [${p.title}](${url(p.slug)}): ${p.description ?? ''}`), '',
  '## Product', '- [Website and web demo](https://ohagent.ai/)', '- [Source code (GitHub)](https://github.com/Oh-Agent-AI/oh-agent)', '',
  '## Optional', '- [中文文档](https://ohagent.ai/docs/zh/)', '- [Full docs as plain text](https://ohagent.ai/llms-full.txt)', ''].join('\n');

const clean = (body) => body
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/:::\w+\[(.*?)\]\n/g, '**$1:** ').replace(/^:::\s*$/gm, '')
  .replace(/\]\((\/[^)]*)\)/g, '](https://ohagent.ai$1)')
  .replace(/\n{3,}/g, '\n\n').trim();

const full = ['# Oh Agent: full documentation (plain text)', '', 'Source: https://ohagent.ai/docs/ (published pages only). Version described: 1.0.0-beta.3 (pre-release).', '',
  ...pages.flatMap((p) => ['---', '', `# ${p.title}`, `URL: ${url(p.slug)}`, '', clean(p.body), ''])].join('\n');

writeFileSync(join(here, 'public/llms.txt'), llms);
writeFileSync(join(here, 'public/llms-full.txt'), full);
console.log(`llms.txt: ${pages.length} published pages`);
