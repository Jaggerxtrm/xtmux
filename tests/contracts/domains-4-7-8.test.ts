/**
 * Contract tests for the pure logic of phases 4 / 7 / 8 (PRD §22).
 * Run: bun test tests/contracts/domains-4-7-8.test.ts
 *
 * The DB-backed halves (register/heartbeat/list, insert-then-update, run+findings
 * persistence) land on top of the Phase 2 SQLite adapter. Everything here is the
 * decision logic those paths delegate to, and it is testable without the scaffold.
 */
import { describe, expect, test } from 'bun:test'
import {
  assertHeartbeat,
  assertTransition,
  IllegalTransitionError,
  leaseExpiry,
  reconcile,
} from '../../src/domains/monitors/terminal'
import { classify, isInterrupted, terminalStatusFor } from '../../src/domains/telemetry/classify'
import { fingerprint, IDENTITY_KEYS, SEVERITY_OF } from '../../src/domains/audit/fingerprint'

// ─────────────────────────────────────────────────────────── monitors (3xs.4)

describe('monitor lifecycle', () => {
  test('active monitor may reach any terminal status', () => {
    for (const s of ['done', 'timeout', 'killed', 'target_gone', 'process_gone', 'error'] as const) {
      expect(assertTransition('m1', null, s)).toBe(true)
    }
  })

  test('terminal is absorbing: a second, different terminal status is rejected', () => {
    expect(() => assertTransition('m1', 'done', 'killed')).toThrow(IllegalTransitionError)
  })

  test('re-asserting the same terminal status is an idempotent no-op, not an error', () => {
    // the poll loop and a reconcile pass can race on the same conclusion
    expect(assertTransition('m1', 'process_gone', 'process_gone')).toBe(false)
  })

  test('a non-status value is rejected', () => {
    expect(() => assertTransition('m1', null, 'finished')).toThrow(IllegalTransitionError)
  })

  test('heartbeat against a terminal monitor is rejected', () => {
    expect(() => assertHeartbeat('m1', 'done')).toThrow(IllegalTransitionError)
    expect(assertHeartbeat('m1', null)).toBeUndefined()
  })

  test('lease is 3 ticks, floored at 30s', () => {
    expect(leaseExpiry(1_000, 60_000)).toBe(1_000 + 180_000) // 3 x 60s
    expect(leaseExpiry(1_000, 1_000)).toBe(1_000 + 30_000) // floor, not 3s
  })
})

describe('monitor reconciliation', () => {
  const base = {
    terminalStatus: null,
    ownerPid: 4242,
    leaseExpiresAtMs: 10_000,
    startedAtMs: 0,
    timeoutMs: null,
    nowMs: 5_000,
    pidAlive: true,
    paneAlive: true,
  }

  test('healthy monitor stays active', () => {
    expect(reconcile(base)).toBeNull()
  })

  test('owner pid gone -> process_gone', () => {
    expect(reconcile({ ...base, pidAlive: false })).toBe('process_gone')
  })

  test('target pane gone -> target_gone (more specific than a dead owner)', () => {
    expect(reconcile({ ...base, paneAlive: false, pidAlive: false })).toBe('target_gone')
  })

  test('lease lapsed -> process_gone, even if the owner pid is still alive', () => {
    // Contract (3xs.4): "rows past lease_expires_at_ms with no fresh heartbeat ->
    // process_gone". A poller that is alive but has not heartbeat in 3+ ticks is
    // hung, and a hung monitor is not observing anything. The 30s lease floor
    // keeps normal scheduling jitter well clear of this.
    expect(reconcile({ ...base, nowMs: 11_000 })).toBe('process_gone')
    expect(reconcile({ ...base, ownerPid: null, nowMs: 11_000 })).toBe('process_gone')
    expect(reconcile({ ...base, nowMs: 9_999 })).toBeNull() // lease still valid
  })

  test('timeout exceeded -> timeout', () => {
    expect(reconcile({ ...base, timeoutMs: 3_000 })).toBe('timeout')
    expect(reconcile({ ...base, timeoutMs: 0 })).toBeNull() // V1: 0 means "no timeout"
  })

  test('an already-terminal row is never re-decided', () => {
    expect(reconcile({ ...base, terminalStatus: 'done', paneAlive: false })).toBeNull()
  })
})

// ────────────────────────────────────────────────────────── telemetry (3xs.7)

describe('telemetry classification', () => {
  // Each case is a V1 event name that must survive verbatim as journalType.
  const cases: Array<[string, string[], string, string]> = [
    ['git', ['commit', '-m', 'x'], 'commit', 'git.commit'],
    ['git', ['push'], 'push', 'git.push'],
    ['git', ['merge', 'main'], 'merge', 'git.merge'],
    ['git', ['rev-parse', 'HEAD'], 'command', 'git.command'],
    ['bd', ['create', '--title', 'x'], 'create', 'bd.create'],
    ['bd', ['close', 'x-1'], 'close', 'bd.close'],
    ['bd', ['remember', 'x'], 'remember', 'bd.remember'],
    ['bd', ['update', 'x-1', '--claim'], 'claim', 'bd.claim'],
    ['bd', ['update', 'x-1', '--claim=me'], 'claim', 'bd.claim'],
    ['bd', ['update', 'x-1', '--notes', 'x'], 'update', 'bd.update'],
    ['bd', ['list'], 'command', 'bd.command'],
    ['gh', ['pr', 'create', '--fill'], 'pr.create', 'git.pr.create'],
    ['gh', ['pr', 'merge', '7'], 'pr.merge', 'git.pr.merge'],
    ['gh', ['pr', 'list'], 'command', 'gh.command'],
    ['gh', ['--version'], 'command', 'gh.command'],
  ]

  for (const [tool, argv, operation, journalType] of cases) {
    test(`${tool} ${argv.join(' ')} -> ${journalType}`, () => {
      const c = classify(tool, argv)
      expect(c.operation).toBe(operation)
      expect(c.journalType).toBe(journalType)
    })
  }

  test('git metadata is captured for git and gh, never for bd (matches V1)', () => {
    expect(classify('git', ['push']).capturesGitMetadata).toBe(true)
    expect(classify('gh', ['pr', 'list']).capturesGitMetadata).toBe(true)
    expect(classify('bd', ['list']).capturesGitMetadata).toBe(false)
  })

  test('unknown tool is rejected', () => {
    expect(() => classify('rm', ['-rf', '/'])).toThrow(/unknown tool/)
  })

  test('terminal status follows exit code', () => {
    expect(terminalStatusFor(0)).toBe('success')
    expect(terminalStatusFor(128)).toBe('failed')
    expect(terminalStatusFor(null)).toBe('interrupted')
  })
})

describe('interrupted-run detection', () => {
  const dead = () => false
  const alive = () => true

  test('a finished run is never interrupted', () => {
    const r = { startedAtMs: 0, finishedAtMs: 5, ownerPid: 1 }
    expect(isInterrupted(r, 1e12, dead)).toBe(false)
  })

  test('pid check is authoritative: dead owner -> interrupted immediately', () => {
    const r = { startedAtMs: 0, finishedAtMs: null, ownerPid: 1 }
    expect(isInterrupted(r, 1_000, dead)).toBe(true)
    expect(isInterrupted(r, 1_000, alive)).toBe(false) // still in flight
  })

  test('without a pid, fall back to the age threshold', () => {
    const r = { startedAtMs: 0, finishedAtMs: null, ownerPid: null }
    expect(isInterrupted(r, 14 * 60_000, dead)).toBe(false)
    expect(isInterrupted(r, 16 * 60_000, dead)).toBe(true)
  })
})

// ────────────────────────────────────────────────────────────── audit (3xs.8)

describe('audit fingerprints', () => {
  const dirty = { session_name: 'xt-design', path: '/w/a', dirty_count: '3', repo: 'a' }

  test('stable across calls and across process restarts (pure of pid/clock/random)', () => {
    expect(fingerprint('dirty-worktree', dirty)).toBe(fingerprint('dirty-worktree', dirty))
    // hardcoded: a change to the recipe must fail this test loudly, not silently
    // orphan every finding row already in the DB.
    expect(fingerprint('dirty-worktree', dirty)).toBe('c44877ead464c35c85eaaefafea102a9')
  })

  test('the volatile part of a finding is NOT identity', () => {
    // same worktree, 30 dirty files instead of 3 -> same finding, last_seen_ms advances
    const later = { ...dirty, dirty_count: '30' }
    expect(fingerprint('dirty-worktree', later)).toBe(fingerprint('dirty-worktree', dirty))
  })

  test('different subject -> different fingerprint', () => {
    expect(fingerprint('dirty-worktree', { ...dirty, path: '/w/b' })).not.toBe(
      fingerprint('dirty-worktree', dirty),
    )
    expect(fingerprint('dirty-worktree', { ...dirty, session_name: 'other' })).not.toBe(
      fingerprint('dirty-worktree', dirty),
    )
  })

  test('kind is part of the hash: same subject, different kind -> different fingerprint', () => {
    expect(fingerprint('working-do-not-kill', { session_name: 'x' })).not.toBe(
      fingerprint('naming-convention', { session_name: 'x' }),
    )
  })

  test('identity keys on session_name, never on the recycled tmux ids', () => {
    // a tmux restart hands out new $N / %N; the finding must not re-fingerprint
    const before = { session_name: 'xtmux', pane_index: '1.2', pane_id: '%1931', session_id: '$1732' }
    const after = { ...before, pane_id: '%7', session_id: '$3' }
    expect(fingerprint('agent-pane-without-bead', after)).toBe(
      fingerprint('agent-pane-without-bead', before),
    )
  })

  test('a missing identity field is a caller bug, not an anonymous finding', () => {
    // otherwise every nameless finding collapses onto one fingerprint
    expect(() => fingerprint('missing-path', { session_name: 'x' })).toThrow(/missing identity field path/)
    expect(() => fingerprint('stale-specialist', { session_name: '' })).toThrow(/missing identity field/)
  })

  test('every kind has a severity and an identity tuple', () => {
    for (const kind of Object.keys(SEVERITY_OF) as Array<keyof typeof SEVERITY_OF>) {
      expect(IDENTITY_KEYS[kind]?.length).toBeGreaterThan(0)
    }
  })
})
