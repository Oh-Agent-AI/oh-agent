# Oh Agent Documentation Site

Starlight (Astro) documentation site for Oh Agent, served at `https://ohagent.ai/docs/`
(English) and `https://ohagent.ai/docs/zh/` (Simplified Chinese). It describes the `dev` branch.

## Structure

- `src/content/docs/`: English pages (root locale, `/docs/...`)
- `src/content/docs/zh/`: Simplified Chinese pages (`/docs/zh/...`)
- `sidebar.mjs`: full navigation; draft pages are filtered out of production builds
- `tools/build-llms.mjs`: generates `public/llms.txt` and `public/llms-full.txt` from published English pages (runs on every build)

## Building

Requires Node.js 22.22 or later (Astro 7).

```bash
npm ci
npm run build    # production build: drafts excluded. Output: dist/
npm run dev      # local preview: drafts included, with a draft banner
```

## Gradual release (one page at a time)

Only a launch-day core set is published. Every other page carries `draft: true` in its frontmatter:
Starlight leaves drafts out of production builds, the sidebar hides them, and the sitemap never lists them.

To publish a page:

1. Make sure the en and zh files contain no TBD / 待确认 placeholders and every claim is checked against `dev`.
2. Remove `draft: true` from **both** `src/content/docs/<page>.md` and `src/content/docs/zh/<page>.md`.
3. Set `lastUpdated: YYYY-MM-DD` to the release date (used for the page footer and sitemap `<lastmod>`).
4. Check that no published page links to a page that is still a draft.
5. `npm run build`, then deploy with `website/landing/deploy.sh`.

The backlog of held-back pages lives outside the repo in the launch plan (`docs-backlog.md`).

## Deployment

`website/landing/deploy.sh` builds this site and copies `dist/` into the landing stage under `/docs`,
so a single Cloudflare Pages deploy (project `oh-agent-landing`) serves both. The landing's
`/sitemap.xml` is a sitemap index that references `/docs/sitemap-index.xml`.
`llms.txt` and `llms-full.txt` are also copied to the site root.
