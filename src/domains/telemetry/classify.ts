/**
 * Command classification for correlated telemetry (xtmux-3xs.7, PRD §13).
 *
 * V1 derives an event *name* from argv inside the shell wrapper. V2 needs the
 * same derivation, split into (tool, operation) for the `command_runs` row —
 * while still emitting the identical journal envelope `type`, so V1 consumers
 * and the golden fixtures stay byte-identical.
 *
 * Pure: no DB, no clock, no git, no tmux.
 */

export const TOOLS = ['git', 'bd', 'gh'] as const
export type Tool = (typeof TOOLS)[number]

export const TERMINAL_STATUSES = ['success', 'failed', 'interrupted'] as const
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number]

export interface Classification {
  tool: Tool
  operation: string
  /** journal envelope `type` — must match V1 exactly */
  journalType: string
  /** V1 only resolves repo/branch/head for git and gh, never for bd */
  capturesGitMetadata: boolean
}

export function isTool(v: string): v is Tool {
  return (TOOLS as readonly string[]).includes(v)
}

function bdOperation(argv: readonly string[]): string {
  switch (argv[0]) {
    case 'create':
      return 'create'
    case 'close':
      return 'close'
    case 'remember':
      return 'remember'
    case 'update':
      // V1: `bd update … --claim` / `--claim=…` is reported as bd.claim, not bd.update.
      return argv.some((a) => a === '--claim' || a.startsWith('--claim=')) ? 'claim' : 'update'
    default:
      return 'command'
  }
}

function gitOperation(argv: readonly string[]): string {
  switch (argv[0]) {
    case 'commit':
      return 'commit'
    case 'push':
      return 'push'
    case 'merge':
      return 'merge'
    default:
      return 'command'
  }
}

function ghOperation(argv: readonly string[]): string {
  if (argv[0] === 'pr' && argv[1] === 'create') return 'pr.create'
  if (argv[0] === 'pr' && argv[1] === 'merge') return 'pr.merge'
  return 'command'
}

/**
 * gh's PR operations keep git.* journal types in V1 (git.pr.create /
 * git.pr.merge), while everything else under gh is gh.command. Preserved
 * deliberately: changing it would break existing log queries.
 */
function journalTypeFor(tool: Tool, operation: string): string {
  if (tool === 'gh' && operation.startsWith('pr.')) return `git.${operation}`
  return `${tool}.${operation}`
}

export function classify(tool: string, argv: readonly string[]): Classification {
  if (!isTool(tool)) throw new Error(`telemetry: unknown tool: ${tool}`)
  const operation =
    tool === 'git' ? gitOperation(argv) : tool === 'bd' ? bdOperation(argv) : ghOperation(argv)
  return {
    tool,
    operation,
    journalType: journalTypeFor(tool, operation),
    capturesGitMetadata: tool !== 'bd',
  }
}

export function terminalStatusFor(exitCode: number | null): TerminalStatus {
  if (exitCode === null) return 'interrupted'
  return exitCode === 0 ? 'success' : 'failed'
}

/**
 * A run with no finish is either in flight or orphaned. The PID check is
 * authoritative; the age threshold is the fallback for a recycled PID or a row
 * written by another host. 15 min sits well above the slow tail of anything we
 * wrap (`gh pr create`, `bd close` — both seconds).
 */
export const INTERRUPTED_THRESHOLD_MS = 15 * 60 * 1000

export function isInterrupted(
  run: { startedAtMs: number; finishedAtMs: number | null; ownerPid: number | null },
  nowMs: number,
  pidAlive: (pid: number) => boolean,
): boolean {
  if (run.finishedAtMs !== null) return false
  if (run.ownerPid !== null) return !pidAlive(run.ownerPid)
  return nowMs - run.startedAtMs > INTERRUPTED_THRESHOLD_MS
}
