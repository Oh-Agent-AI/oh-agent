// Oh Agent docs (Starlight)
// Mounted at https://ohagent.ai/docs  →  en: /docs/...   zh: /docs/zh/...
// Deployed together with the landing page by website/landing/deploy.sh.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import sitemap from '@astrojs/sitemap';
import { sidebar } from './sidebar.mjs';

const contentRoot = fileURLToPath(new URL('./src/content/docs/', import.meta.url));

/** URL (https://ohagent.ai/docs/zh/install) → source file (src/content/docs/zh/install.md). */
function sourceFor(url) {
  const path = new URL(url).pathname.replace(/^\/docs\/?/, '').replace(/\.html$/, '').replace(/\/$/, '');
  const candidates = path === '' || path === 'zh' ? [`${path ? 'zh/' : ''}index.md`] : [`${path}.md`, `${path}/index.md`];
  for (const rel of candidates) {
    try { return { rel, text: readFileSync(contentRoot + rel, 'utf8') }; } catch { /* next */ }
  }
  return null;
}

/** lastmod = frontmatter `lastUpdated`, else the file's last git commit date. */
function lastmodFor(url) {
  const src = sourceFor(url);
  if (!src) return undefined;
  const fm = src.text.match(/^---\n([\s\S]*?)\n---/);
  const explicit = fm && fm[1].match(/^lastUpdated:\s*['"]?(\d{4}-\d{2}-\d{2})/m);
  if (explicit) return new Date(`${explicit[1]}T00:00:00Z`).toISOString();
  try {
    const iso = execFileSync('git', ['log', '-1', '--format=%cI', '--', contentRoot + src.rel], { encoding: 'utf8' }).trim();
    return iso ? new Date(iso).toISOString() : undefined;
  } catch { return undefined; }
}

export default defineConfig({
  site: 'https://ohagent.ai',
  base: '/docs',
  trailingSlash: 'ignore',
  build: {
    format: 'directory',   // /docs/install/index.html → served as /docs/install/ on Cloudflare Pages
    assets: '_docs',       // keep clear of the landing site's root files
  },
  integrations: [
    // Our own sitemap instance (Starlight skips adding its default one when this is present).
    // Same i18n alternates as Starlight's, plus <lastmod>. Drafts are never built, so never listed.
    sitemap({
      i18n: { defaultLocale: 'root', locales: { root: 'en', zh: 'zh-CN' } },
      serialize(item) {
        const lastmod = lastmodFor(item.url);
        return lastmod ? { ...item, lastmod } : item;
      },
    }),
    starlight({
      title: 'Oh Agent Docs',
      favicon: '/favicon.png',
      customCss: ['./src/styles/custom.css'],
      logo: { src: './src/assets/app-icon.png', alt: 'Oh Agent' },
      description: 'Docs for Oh Agent, a free, open-source, local-first app that turns Claude Code and Codex session history into a 3D city. Beta for Apple Silicon Mac, Windows and Linux.',
      // Root locale = English (no prefix). Chinese lives under /docs/zh/.
      defaultLocale: 'root',
      locales: {
        root: { label: 'English', lang: 'en' },
        zh: { label: '简体中文', lang: 'zh-CN' },
      },
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/Oh-Agent-AI/oh-agent' },
        { icon: 'x.com', label: 'X', href: 'https://x.com/ohagentai' },
      ],
      sidebar,
      // "Last updated" footer: frontmatter `lastUpdated:` wins, otherwise git history
      // (needs a full clone; CI uses fetch-depth: 0).
      lastUpdated: true,
      head: [
        { tag: 'meta', attrs: { property: 'og:site_name', content: 'Oh Agent' } },
        { tag: 'link', attrs: { rel: 'alternate', type: 'text/plain', title: 'llms.txt', href: 'https://ohagent.ai/llms.txt' } },
      ],
    }),
  ],
});
