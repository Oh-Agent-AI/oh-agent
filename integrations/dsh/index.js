/**
 * Agent Vitals — DeepSeek Harness profile bundle glue plugin.
 *
 * Registers ONE skill provider on ctx.skills that serves this package's
 * SKILL.md. The scanner itself is deliberately NOT bundled here: the three
 * hard constraints (npm-prebuilt only, no scanner copy, no build step) mean
 * the audit runs from the `agent-vitals` binary on PATH or from a repo
 * checkout — the skill body explains both.
 *
 * No dependencies, no TypeScript, no build step: this file ships as-is.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const skillPath = join(here, 'SKILL.md')

export const name = 'agent-vitals'
export const inject = ['skills']

// Minimal dependency-free frontmatter parse. The bundle's SKILL.md keeps a
// single-line `name:` and `description:` (and optional `whenToUse:`), so a
// line split is enough — no YAML parser, no third-party code.
function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text)
  if (!match) throw new Error('dsh-agent-vitals: SKILL.md is missing frontmatter')
  const frontmatter = {}
  for (const line of match[1].split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon > 0) {
      const key = line.slice(0, colon).trim()
      const value = line.slice(colon + 1).trim()
      if (key) frontmatter[key] = value
    }
  }
  return { frontmatter, content: match[2] }
}

let cached = null

async function readSkill() {
  if (cached === null) {
    const text = await readFile(skillPath, 'utf8')
    const { frontmatter, content } = parseFrontmatter(text)
    cached = { frontmatter, content }
  }
  return cached
}

export function apply(ctx) {
  ctx.skills.registerProvider(() => ({
    name: 'agent-vitals',

    async list() {
      const { frontmatter } = await readSkill()
      return [{
        name: frontmatter.name,
        description: frontmatter.description,
        ...(frontmatter.whenToUse !== undefined ? { whenToUse: frontmatter.whenToUse } : {}),
        invocation: { modelInvocable: true, userInvocable: true },
        source: 'bundled',
        provider: 'agent-vitals',
        rank: 600,
        locator: { path: skillPath },
        resourceBase: { kind: 'directory', path: here },
        path: skillPath,
      }]
    },

    async get(candidate) {
      const { content } = await readSkill()
      return {
        name: candidate.name,
        description: candidate.description,
        ...(candidate.whenToUse !== undefined ? { whenToUse: candidate.whenToUse } : {}),
        invocation: candidate.invocation,
        source: candidate.source,
        provider: candidate.provider,
        resourceBase: candidate.resourceBase,
        path: candidate.path,
        content,
      }
    },
  }))
}
