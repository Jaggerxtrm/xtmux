/**
 * Stable audit-finding fingerprints (xtmux-3xs.8, PRD §14).
 *
 * Repeat audits must advance `last_seen_ms` on the existing row, not insert a
 * duplicate — so the fingerprint has to be a pure function of the finding's
 * *identity*, stable across process restarts. Two consequences drive the recipe:
 *
 *   - The volatile part of a finding is excluded. "This worktree is dirty" is
 *     the same finding whether 3 or 30 files changed; the count lives in
 *     detail_json and is overwritten on each observation.
 *   - Identity keys on session NAME, never on tmux session_id (`$N`) or pane_id
 *     (`%N`) — tmux recycles both, so an id-keyed fingerprint would mint a fresh
 *     finding on every tmux restart and last_seen_ms would never advance.
 *
 * Pure: no DB, no clock, no tmux.
 */
import { createHash } from 'node:crypto'

export const SEVERITIES = ['warning', 'cleanup'] as const
export type Severity = (typeof SEVERITIES)[number]

export const KINDS = [
  'missing-path',
  'stale-specialist',
  'dirty-worktree',
  'shared-worktree',
  'working-do-not-kill',
  'naming-convention',
  'agent-pane-without-bead',
] as const
export type Kind = (typeof KINDS)[number]

/** Fixed severity per kind — matches V1's stdout class exactly. */
export const SEVERITY_OF: Record<Kind, Severity> = {
  'missing-path': 'cleanup',
  'stale-specialist': 'cleanup',
  'dirty-worktree': 'warning',
  'shared-worktree': 'warning',
  'working-do-not-kill': 'warning',
  'naming-convention': 'warning',
  'agent-pane-without-bead': 'warning',
}

/** Which fields identify a finding. Everything else is detail, not identity. */
export const IDENTITY_KEYS: Record<Kind, readonly string[]> = {
  'missing-path': ['session_name', 'path'],
  'stale-specialist': ['session_name'],
  'dirty-worktree': ['session_name', 'path'],
  'shared-worktree': ['session_name', 'path'],
  'working-do-not-kill': ['session_name'],
  'naming-convention': ['session_name'],
  'agent-pane-without-bead': ['session_name', 'pane_index'],
}

export function isKind(v: string): v is Kind {
  return (KINDS as readonly string[]).includes(v)
}

const UNIT = '\x1f' // ASCII unit separator: cannot occur in a tmux name or a path

/**
 * fingerprint = sha256("v1" ␟ kind ␟ k=v ␟ k=v …)[:32], keys sorted.
 *
 * The "v1" prefix is a recipe version: if an identity tuple ever has to change,
 * bump it so old and new fingerprints cannot collide and be silently merged.
 */
export const RECIPE_VERSION = 'v1'

export function fingerprint(kind: Kind, fields: Record<string, string | null | undefined>): string {
  const keys = IDENTITY_KEYS[kind]
  if (!keys) throw new Error(`audit: unknown finding kind: ${kind}`)

  const parts = [...keys]
    .sort()
    .map((k) => {
      const v = fields[k]
      if (v === null || v === undefined || v === '') {
        // An identity field that is absent is a bug in the caller, not a finding
        // that happens to be anonymous: it would collapse every such finding
        // into one fingerprint.
        throw new Error(`audit: finding ${kind} is missing identity field ${k}`)
      }
      return `${k}=${v.trim()}`
    })

  return createHash('sha256')
    .update([RECIPE_VERSION, kind, ...parts].join(UNIT))
    .digest('hex')
    .slice(0, 32)
}
