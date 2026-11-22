// How numbers about the pool are shown to recruiters — the same rule in every email and on the
// /talent hero (src/lib/poolNumber.ts in the frontend mirrors shownNumber; change both together).
//
// Decided 2026-11-22:
//   * milestones every 500 (every 100 below 1,000);
//   * within 10% below the next milestone → that milestone, "about": "~4,000";
//   * otherwise → the milestone below, "more than": "3,500+" / "יותר מ-3,500";
//   * under 100 → not shown at all (a small number makes the pool look empty);
//   * a number shown once is never shown lower: talent_ratchet() keeps the largest per key.
import { adminClient } from './emailPrefs.ts'

export type Shown = { value: number; kind: 'exact' | 'about' | 'over' }

export function shownNumber(n: number): Shown | null {
  if (!Number.isFinite(n) || n < 100) return null
  const step = n >= 1000 ? 500 : 100
  const next = Math.ceil(n / step) * step
  if (next === n) return { value: n, kind: 'exact' }
  if (n >= next * 0.9) return { value: next, kind: 'about' }
  return { value: Math.floor(n / step) * step, kind: 'over' }
}

const fmt = (n: number) => n.toLocaleString('en-US')

/** "~3,500" / "יותר מ-3,000" / "3,000+" — null when the number is too small to show. */
export function shownLabel(n: number, lang: 'he' | 'en'): string | null {
  const s = shownNumber(n)
  if (!s) return null
  if (s.kind === 'exact') return fmt(s.value)
  if (s.kind === 'about') return `~${fmt(s.value)}`
  return lang === 'he' ? `יותר מ-${fmt(s.value)}` : `${fmt(s.value)}+`
}

/** The same, as a short figure for a tile: "~3,500" / "3,000+". */
export function shownFigure(n: number): string | null {
  const s = shownNumber(n)
  if (!s) return null
  return s.kind === 'exact' ? fmt(s.value) : s.kind === 'about' ? `~${fmt(s.value)}` : `${fmt(s.value)}+`
}

export interface Counted { label: string; count: number }
export interface PoolNumbers {
  pool: number
  employed: number
  new_30d: number
  new_7d: number
  seeking: number
  top_skills: Counted[]
  new_skills_30d: Counted[]
  top_titles: Counted[]
  work_prefs: Counted[]
  cities: Counted[]
}

/**
 * The pool in numbers (talent_pool_numbers), with the totals that are shown as headlines passed
 * through talent_ratchet — so a recruiter never sees a total lower than one she was shown before.
 * Cached for the run: every email of a run shows the same numbers.
 */
let cached: { at: number; value: PoolNumbers } | null = null
export async function poolNumbers(): Promise<PoolNumbers> {
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.value
  const db = adminClient()
  const { data, error } = await db.rpc('talent_pool_numbers')
  if (error || !data) throw new Error(`talent_pool_numbers: ${error?.message ?? 'no data'}`)
  const raw = data as PoolNumbers
  const ratchet = async (key: string, value: number) => {
    const { data: kept } = await db.rpc('talent_ratchet', { p_key: key, p_value: value })
    return typeof kept === 'number' ? kept : value
  }
  const [pool, employed] = await Promise.all([ratchet('pool', raw.pool), ratchet('employed', raw.employed)])
  cached = { at: Date.now(), value: { ...raw, pool, employed } }
  return cached.value
}

// Skills as people write them: "c#" → "C#", "full-stack development" → "Full Stack".
const SKILL_NAMES: Record<string, string> = {
  'c#': 'C#', 'react': 'React', 'angular': 'Angular', 'python': 'Python', 'java': 'Java', 'javascript': 'JavaScript',
  'typescript': 'TypeScript', '.net core': '.NET Core', '.net': '.NET', 'full-stack development': 'Full Stack',
  'sql': 'SQL', 'node.js': 'Node.js', 'vue': 'Vue', 'devops': 'DevOps', 'qa': 'QA',
}
/** Skills too generic to make a search of their own. */
const GENERIC_SKILLS = new Set(['git', 'github', 'html', 'css', 'rest apis', 'rest api', 'html5', 'css3'])

export const skillName = (s: string) => SKILL_NAMES[s.trim().toLowerCase()] ?? (s.trim().charAt(0).toUpperCase() + s.trim().slice(1))
export const isGenericSkill = (s: string) => GENERIC_SKILLS.has(s.trim().toLowerCase())
