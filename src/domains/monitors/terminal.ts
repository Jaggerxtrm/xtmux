/**
 * Monitor lifecycle state machine (xtmux-3xs.4, PRD §11).
 *
 * A monitor row has two orthogonal state columns, routinely conflated in V1:
 *   - `state`           the observed agent state of the target pane; churns every poll
 *   - `terminal_status` the monitor's own lifecycle; NULL while active, then absorbing
 *
 * This module owns the second one. Pure: no DB, no clock, no tmux.
 */

export const TERMINAL_STATUSES = [
  'done',
  'timeout',
  'killed',
  'target_gone',
  'process_gone',
  'error',
] as const

export type TerminalStatus = (typeof TERMINAL_STATUSES)[number]

/** NULL terminal_status = the monitor is still active. */
export type MonitorLifecycle = TerminalStatus | null

export function isTerminalStatus(v: unknown): v is TerminalStatus {
  return typeof v === 'string' && (TERMINAL_STATUSES as readonly string[]).includes(v)
}

export class IllegalTransitionError extends Error {
  readonly code = 'monitor.illegal_transition'
  constructor(
    readonly monitorId: string,
    readonly from: MonitorLifecycle,
    readonly to: unknown,
    reason: string,
  ) {
    super(`monitor ${monitorId}: illegal transition ${from ?? 'active'} -> ${String(to)}: ${reason}`)
    this.name = 'IllegalTransitionError'
  }
}

/**
 * Terminal is absorbing: an active monitor may reach exactly one terminal
 * status, and nothing may move it afterwards. Re-asserting the *same* terminal
 * status is idempotent (a poll loop and a reconcile pass can race on the same
 * conclusion — that is not an error, it is the same fact twice).
 *
 * @returns true if the caller should write the transition, false if it is a
 *          no-op. Throws on an actually illegal move.
 */
export function assertTransition(
  monitorId: string,
  from: MonitorLifecycle,
  to: unknown,
): boolean {
  if (!isTerminalStatus(to)) {
    throw new IllegalTransitionError(monitorId, from, to, 'not a terminal status')
  }
  if (from === null) return true
  if (from === to) return false // idempotent re-assertion, not a second transition
  throw new IllegalTransitionError(
    monitorId,
    from,
    to,
    'monitor is already terminal; terminal status is absorbing',
  )
}

/** Heartbeats are only legal against an active monitor. */
export function assertHeartbeat(monitorId: string, from: MonitorLifecycle): void {
  if (from !== null) {
    throw new IllegalTransitionError(monitorId, from, 'heartbeat', 'cannot heartbeat a terminal monitor')
  }
}

/**
 * Lease: three missed poll ticks, floored at 30s so short intervals do not
 * produce a lease that expires inside normal scheduling jitter.
 */
export const LEASE_TICKS = 3
export const LEASE_FLOOR_MS = 30_000

export function leaseExpiry(heartbeatAtMs: number, intervalMs: number): number {
  return heartbeatAtMs + Math.max(LEASE_TICKS * intervalMs, LEASE_FLOOR_MS)
}

export interface ReconcileInput {
  terminalStatus: MonitorLifecycle
  ownerPid: number | null
  leaseExpiresAtMs: number | null
  startedAtMs: number
  timeoutMs: number | null
  nowMs: number
  pidAlive: boolean
  paneAlive: boolean
}

/**
 * Decide the terminal status a reconciliation pass (monitor-list) should apply
 * to a row, or null to leave it active. Order matters: the target disappearing
 * is a more specific fact than the owner dying, and both are more specific than
 * a lease that merely lapsed.
 */
export function reconcile(m: ReconcileInput): TerminalStatus | null {
  if (m.terminalStatus !== null) return null // already terminal; absorbing
  if (!m.paneAlive) return 'target_gone'
  if (m.ownerPid !== null && !m.pidAlive) return 'process_gone'
  if (m.leaseExpiresAtMs !== null && m.nowMs > m.leaseExpiresAtMs) return 'process_gone'
  if (m.timeoutMs !== null && m.timeoutMs > 0 && m.nowMs - m.startedAtMs >= m.timeoutMs) return 'timeout'
  return null
}
