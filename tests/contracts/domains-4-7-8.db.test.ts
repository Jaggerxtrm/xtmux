/**
 * DB-backed contract tests for phases 4 / 7 / 8 (PRD §22).
 * Run: bun test tests/contracts/domains-4-7-8.db.test.ts
 *
 * One test per VALIDATION checkbox in xtmux-3xs.4 / .7 / .8, minus the two that
 * need the CLI wired (shadow-mode divergence, zero /tmp writes) — those land with
 * the picker routing branch on top of Phase 2.
 *
 * Uses an in-memory DB and the DDL this phase owns, so it runs before Phase 2's
 * migration framework exists and keeps running after (schema-4-7-8.ts is what
 * Phase 2 applies).
 */
import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { DDL_DOMAINS_4_7_8 } from '../../src/domains/schema-4-7-8'
import { RecordingJournal } from '../../src/domains/journal'
import { adopt, register } from '../../src/domains/monitors/register'
import { heartbeat, MonitorNotFoundError, terminate } from '../../src/domains/monitors/heartbeat'
import { list } from '../../src/domains/monitors/list'
import { kill } from '../../src/domains/monitors/kill'
import { reconcileAll } from '../../src/domains/monitors/reconcile'
import { IllegalTransitionError } from '../../src/domains/monitors/terminal'
import { start } from '../../src/domains/telemetry/start'
import { finish } from '../../src/domains/telemetry/finish'
import { incompleteRuns, reconcileIncomplete } from '../../src/domains/telemetry/reconcile'
import { completeRun, startRun } from '../../src/domains/audit/run'
import { openFindings, record, type Finding } from '../../src/domains/audit/find'

let db: Database
let journal: RecordingJournal

beforeEach(() => {
  db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(DDL_DOMAINS_4_7_8)
  journal = new RecordingJournal()
})

const T0 = 1_700_000_000_000
const allAlive = { pidAlive: () => true, paneAlive: () => true, signal: () => {} }

function reg(id = 'm1', over: Partial<Parameters<typeof register>[2]> = {}) {
  register(db, journal, {
    id,
    target: 'xtmux:1.2',
    paneId: '%1931',
    sessionId: '$1732',
    state: 'working',
    intervalMs: 30_000,
    timeoutMs: null,
    nowMs: T0,
    ...over,
  })
  return id
}
const row = (id: string) => db.query(`SELECT * FROM monitors WHERE id = $id`).get({ $id: id }) as any
const monitorCount = () => (db.query(`SELECT COUNT(*) c FROM monitors`).get() as any).c

// ═════════════════════════════════════════════════════════════ monitors (3xs.4)

describe('3xs.4 monitors', () => {
  test('register + heartbeat + done: 1 row, 3 envelopes, terminal_status=done', () => {
    reg()
    heartbeat(db, journal, 'm1', 'idle', T0 + 30_000)
    terminate(db, journal, 'm1', 'done', T0 + 60_000)

    expect(monitorCount()).toBe(1)
    expect(row('m1').terminal_status).toBe('done')
    // The contract's "3 envelopes": registration, the observed state actually
    // changing (working -> idle, which is what makes the monitor conclude), and
    // the terminal transition. A tick that observes no change is not an envelope.
    expect(journal.events()).toEqual(['monitor.started', 'monitor.state', 'monitor.done'])
  })

  test('a heartbeat writes columns in place — no new row, and no envelope unless the state moved', () => {
    reg()
    for (let i = 1; i <= 100; i++) heartbeat(db, journal, 'm1', 'working', T0 + i * 1_000)

    expect(monitorCount()).toBe(1)
    expect(journal.events()).toEqual(['monitor.started']) // 100 ticks, 0 extra envelopes
    expect(row('m1').heartbeat_at_ms).toBe(T0 + 100_000)
    expect(row('m1').lease_expires_at_ms).toBe(T0 + 100_000 + 90_000) // 3 x 30s interval
  })

  test('timeout: monitor past timeout_ms -> terminal_status=timeout, terminal_at_ms set', () => {
    reg('m1', { timeoutMs: 60_000 })
    const out = reconcileAll(db, journal, allAlive, T0 + 61_000)

    expect(out).toEqual([{ id: 'm1', status: 'timeout' }])
    expect(row('m1').terminal_status).toBe('timeout')
    expect(row('m1').terminal_at_ms).toBe(T0 + 61_000)
  })

  test('kill: terminal_status=killed and the row is PRESERVED (V1 deleted it)', () => {
    reg()
    adopt(db, 'm1', 4242, T0)
    let signalled: number | null = null

    const out = kill(db, journal, { signal: (pid) => (signalled = pid) }, 'm1', T0 + 10)

    expect(out).toBe('killed\tm1')
    expect(signalled).toBe(4242)
    expect(monitorCount()).toBe(1) // history survives the kill
    expect(row('m1').terminal_status).toBe('killed')
  })

  test('kill on an unknown id throws MonitorNotFoundError (V1: exit 1)', () => {
    expect(() => kill(db, journal, allAlive, 'nope', T0)).toThrow(MonitorNotFoundError)
  })

  test('owner process gone: pid absent -> process_gone', () => {
    reg()
    adopt(db, 'm1', 4242, T0)
    reconcileAll(db, journal, { ...allAlive, pidAlive: () => false }, T0 + 1_000)

    expect(row('m1').terminal_status).toBe('process_gone')
  })

  test('target pane gone -> target_gone', () => {
    reg()
    adopt(db, 'm1', 4242, T0)
    reconcileAll(db, journal, { ...allAlive, paneAlive: () => false }, T0 + 1_000)

    expect(row('m1').terminal_status).toBe('target_gone')
  })

  test('lease expiry: no heartbeat past the lease -> process_gone', () => {
    reg() // lease = T0 + 90s
    adopt(db, 'm1', 4242, T0)
    expect(reconcileAll(db, journal, allAlive, T0 + 89_000)).toEqual([]) // still leased
    reconcileAll(db, journal, allAlive, T0 + 91_000)

    expect(row('m1').terminal_status).toBe('process_gone')
  })

  test('restart reconciliation: crash mid-poll leaves no orphan; monitor-list converges', () => {
    reg()
    adopt(db, 'm1', 4242, T0)
    // the poller is killed -9 mid-tick: no terminal write, row still active
    expect(row('m1').terminal_status).toBeNull()

    const lines = list(
      db,
      journal,
      { ...allAlive, pidAlive: () => false, observe: () => 'idle' },
      T0 + 1_000,
    )

    expect(row('m1').terminal_status).toBe('process_gone')
    expect(lines).toEqual([]) // and it drops out of the listing
  })

  test('concurrent heartbeats: 4 monitors x 100 ticks, no lost updates', () => {
    const ids = ['m1', 'm2', 'm3', 'm4']
    for (const id of ids) reg(id)
    for (let i = 1; i <= 100; i++) for (const id of ids) heartbeat(db, journal, id, 'working', T0 + i * 1_000)

    expect(monitorCount()).toBe(4)
    for (const id of ids) expect(row(id).heartbeat_at_ms).toBe(T0 + 100_000)
  })

  test('terminal is absorbing: a second, different status is rejected', () => {
    reg()
    terminate(db, journal, 'm1', 'done', T0 + 10)
    expect(() => terminate(db, journal, 'm1', 'killed', T0 + 20)).toThrow(IllegalTransitionError)
    expect(row('m1').terminal_status).toBe('done')
  })

  test('the poll loop and a reconcile pass racing on the same conclusion is not an error', () => {
    reg()
    adopt(db, 'm1', 4242, T0)
    expect(terminate(db, journal, 'm1', 'process_gone', T0 + 10)).toBe(true)
    // reconcile independently reaches process_gone: idempotent no-op, no throw
    expect(reconcileAll(db, journal, { ...allAlive, pidAlive: () => false }, T0 + 20)).toEqual([])
    expect(row('m1').terminal_status).toBe('process_gone')
  })

  test('heartbeat against a terminal monitor is rejected', () => {
    reg()
    terminate(db, journal, 'm1', 'done', T0 + 10)
    expect(() => heartbeat(db, journal, 'm1', 'working', T0 + 20)).toThrow(IllegalTransitionError)
  })

  test('monitor-list is byte-compatible with V1: 10-col TSV in seconds, sorted by start,id', () => {
    reg('m2', { timeoutMs: 1_800_000 }) // registered first, but a later start
    reg('m1', { nowMs: T0 - 5_000 })
    adopt(db, 'm1', 111, T0)

    const lines = list(db, journal, { ...allAlive, observe: () => 'running' }, T0)

    expect(lines).toEqual([
      // m1 started 5s earlier, so it sorts first; m2 has no pid yet -> `starting`
      `monitor\tm1\t111\txtmux:1.2\t%1931\trunning\t${(T0 - 5_000) / 1000}\t0\t30\t${T0 / 1000}`,
      `monitor\tm2\tstarting\txtmux:1.2\t%1931\trunning\t${T0 / 1000}\t1800\t30\t${T0 / 1000}`,
    ])
  })

  test('a terminal monitor stays in the table but drops out of the listing', () => {
    reg()
    terminate(db, journal, 'm1', 'done', T0 + 10)

    expect(list(db, journal, { ...allAlive, observe: () => 'idle' }, T0 + 20)).toEqual([])
    expect(monitorCount()).toBe(1)
  })
})

// ════════════════════════════════════════════════════════════ telemetry (3xs.7)

const runRow = (id: string) =>
  db.query(`SELECT * FROM command_runs WHERE id = $id`).get({ $id: id }) as any
const runCount = () => (db.query(`SELECT COUNT(*) c FROM command_runs`).get() as any).c

function startPush(id = 'c1', over: Partial<Parameters<typeof start>[2]> = {}) {
  return start(db, journal, {
    id,
    tool: 'git',
    argv: ['push'],
    ownerPid: 4242,
    sessionId: '$1732',
    paneId: '%1931',
    beadId: 'xtmux-3xs.7',
    cwd: '/w',
    repo: 'xtmux',
    branchBefore: 'main',
    headBefore: 'abc',
    nowMs: T0,
    ...over,
  })
}

describe('3xs.7 command telemetry', () => {
  test('successful git.push: ONE row, started+finished set, exit 0, success', () => {
    startPush()
    finish(db, journal, { id: 'c1', exitCode: 0, branchAfter: 'main', headAfter: 'def', nowMs: T0 + 900 })

    expect(runCount()).toBe(1) // insert-then-update, never a second insert
    const r = runRow('c1')
    expect(r.started_at_ms).toBe(T0)
    expect(r.finished_at_ms).toBe(T0 + 900)
    expect(r.exit_code).toBe(0)
    expect(r.terminal_status).toBe('success')
    expect(journal.events()).toEqual(['telemetry.command.started', 'git.push'])
    // both envelopes share the row id, which is what V1 could not do
    expect(journal.entries.every((e) => e.correlationId === 'c1')).toBe(true)
    expect(journal.entries[1]?.durationMs).toBe(900)
  })

  test('nonzero exit: exit_code=N, terminal_status=failed', () => {
    startPush()
    finish(db, journal, { id: 'c1', exitCode: 128, nowMs: T0 + 10 })

    expect(runRow('c1').exit_code).toBe(128)
    expect(runRow('c1').terminal_status).toBe('failed')
    expect(journal.entries[1]?.outcome).toBe('error')
  })

  test('before/after git metadata is captured for git.commit/push/merge', () => {
    startPush()
    finish(db, journal, { id: 'c1', exitCode: 0, branchAfter: 'main', headAfter: 'def', nowMs: T0 + 1 })

    const r = runRow('c1')
    expect([r.branch_before, r.head_before, r.branch_after, r.head_after]).toEqual([
      'main',
      'abc',
      'main',
      'def',
    ])
  })

  test('SIGINT mid-run: reconciliation marks interrupted, exit_code stays NULL', () => {
    startPush()
    // the wrapper died before finish(): pid is gone, row has no finish
    const out = reconcileIncomplete(db, journal, { pidAlive: () => false }, T0 + 5_000)

    expect(out).toEqual(['c1'])
    expect(runRow('c1').terminal_status).toBe('interrupted')
    expect(runRow('c1').exit_code).toBeNull() // we do not know what it would have been
    expect(runCount()).toBe(1)
  })

  test('a live in-flight run is NOT swept up as interrupted', () => {
    startPush()
    expect(reconcileIncomplete(db, journal, { pidAlive: () => true }, T0 + 5_000)).toEqual([])
    expect(runRow('c1').terminal_status).toBeNull()
  })

  test('incomplete-run detection returns started-without-finish rows past the threshold', () => {
    startPush('c1') // never finishes
    startPush('c2')
    finish(db, journal, { id: 'c2', exitCode: 0, nowMs: T0 + 1 })

    expect(incompleteRuns(db, T0 + 60_000)).toEqual([]) // 1 min: under the 15 min threshold
    expect(incompleteRuns(db, T0 + 16 * 60_000)).toEqual([
      { id: 'c1', tool: 'git', operation: 'push', started_at_ms: T0 },
    ])
  })

  test('the correlated queries the contract asks for', () => {
    // PR created, never merged
    start(db, journal, {
      id: 'c1',
      tool: 'gh',
      argv: ['pr', 'create', '--fill'],
      ownerPid: 1,
      repo: 'xtmux',
      beadId: 'b1',
      nowMs: T0,
    })
    finish(db, journal, { id: 'c1', exitCode: 0, nowMs: T0 + 1 })
    // a failed bead close
    start(db, journal, { id: 'c2', tool: 'bd', argv: ['close', 'b1'], ownerPid: 1, beadId: 'b1', nowMs: T0 })
    finish(db, journal, { id: 'c2', exitCode: 1, nowMs: T0 + 1 })

    const unmerged = db
      .query(
        `SELECT c.bead_id FROM command_runs c
          WHERE c.operation = 'pr.create' AND c.terminal_status = 'success'
            AND NOT EXISTS (SELECT 1 FROM command_runs m
                             WHERE m.operation = 'pr.merge' AND m.repo = c.repo
                               AND m.started_at_ms > c.started_at_ms)`,
      )
      .all()
    expect(unmerged).toEqual([{ bead_id: 'b1' }])

    const failedCloses = db
      .query(
        `SELECT COUNT(*) c FROM command_runs
          WHERE tool='bd' AND operation='close' AND terminal_status='failed'`,
      )
      .get() as any
    expect(failedCloses.c).toBe(1)
  })

  test('the tool CHECK constraint rejects anything outside git/bd/gh', () => {
    expect(() =>
      db
        .query(
          `INSERT INTO command_runs (id, tool, operation, started_at_ms) VALUES ('x','rm','rf',1)`,
        )
        .run(),
    ).toThrow()
  })
})

// ═══════════════════════════════════════════════════════════════ audit (3xs.8)

const dirty: Finding = {
  kind: 'dirty-worktree',
  sessionName: 'xt-design',
  sessionId: '$1',
  path: '/w/a',
  repo: 'a',
  detail: { dirty_count: 3 },
}
const naming: Finding = { kind: 'naming-convention', sessionName: 'tmp-badname' }

const findingRows = () =>
  db.query(`SELECT * FROM audit_findings ORDER BY id`).all() as any[]

describe('3xs.8 audit', () => {
  test('same finding across 3 audits: 1 row, last_seen_ms advances', () => {
    for (let i = 0; i < 3; i++) {
      const id = startRun(db, journal, `r${i}`, '$1', T0 + i * 1_000)
      record(db, journal, id, dirty, T0 + i * 1_000)
      completeRun(db, journal, id, { warnings: 1, cleanups: 0 }, T0 + i * 1_000)
    }

    const rows = findingRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].first_seen_ms).toBe(T0)
    expect(rows[0].last_seen_ms).toBe(T0 + 2_000)
    expect(rows[0].run_id).toBe('r0') // first run to see it
    expect(rows[0].last_run_id).toBe('r2') // most recent
    expect(rows[0].resolved_at_ms).toBeNull()
  })

  test('the volatile part of a finding does not fork the row', () => {
    const r0 = startRun(db, journal, 'r0', '$1', T0)
    record(db, journal, r0, dirty, T0)
    completeRun(db, journal, r0, { warnings: 1, cleanups: 0 }, T0)

    const r1 = startRun(db, journal, 'r1', '$1', T0 + 1_000)
    record(db, journal, r1, { ...dirty, detail: { dirty_count: 30 } }, T0 + 1_000)
    completeRun(db, journal, r1, { warnings: 1, cleanups: 0 }, T0 + 1_000)

    const rows = findingRows()
    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0].detail_json).dirty_count).toBe(30) // overwritten, not forked
  })

  test('resolution: a finding absent from a later COMPLETE audit gets resolved_at_ms', () => {
    const r0 = startRun(db, journal, 'r0', '$1', T0)
    record(db, journal, r0, dirty, T0)
    record(db, journal, r0, naming, T0)
    completeRun(db, journal, r0, { warnings: 2, cleanups: 0 }, T0)

    // second audit: the worktree got committed, so only `naming` is still found
    const r1 = startRun(db, journal, 'r1', '$1', T0 + 1_000)
    record(db, journal, r1, naming, T0 + 1_000)
    const { resolved } = completeRun(db, journal, r1, { warnings: 1, cleanups: 0 }, T0 + 1_000)

    expect(resolved).toBe(1)
    const rows = findingRows()
    expect(rows.find((r) => r.kind === 'dirty-worktree').resolved_at_ms).toBe(T0 + 1_000)
    expect(rows.find((r) => r.kind === 'naming-convention').resolved_at_ms).toBeNull()
    expect(openFindings(db)).toHaveLength(1)
  })

  test('partial audit: a crash mid-run does NOT false-resolve what it never reached', () => {
    const r0 = startRun(db, journal, 'r0', '$1', T0)
    record(db, journal, r0, dirty, T0)
    record(db, journal, r0, naming, T0)
    completeRun(db, journal, r0, { warnings: 2, cleanups: 0 }, T0)

    // r1 crashes after the first finding: completeRun is never called
    const r1 = startRun(db, journal, 'r1', '$1', T0 + 1_000)
    record(db, journal, r1, naming, T0 + 1_000)
    // ... boom.

    expect(findingRows().every((r) => r.resolved_at_ms === null)).toBe(true)
    expect(openFindings(db)).toHaveLength(2) // dirty-worktree is NOT resolved
    const partial = db.query(`SELECT completed_at_ms FROM audit_runs WHERE id='r1'`).get() as any
    expect(partial.completed_at_ms).toBeNull()
  })

  test('a resolved finding that comes back re-opens the same row', () => {
    const r0 = startRun(db, journal, 'r0', '$1', T0)
    record(db, journal, r0, dirty, T0)
    completeRun(db, journal, r0, { warnings: 1, cleanups: 0 }, T0)

    const r1 = startRun(db, journal, 'r1', '$1', T0 + 1_000) // dirty is gone
    completeRun(db, journal, r1, { warnings: 0, cleanups: 0 }, T0 + 1_000)
    expect(findingRows()[0].resolved_at_ms).toBe(T0 + 1_000)

    const r2 = startRun(db, journal, 'r2', '$1', T0 + 2_000) // and it's back
    record(db, journal, r2, dirty, T0 + 2_000)
    completeRun(db, journal, r2, { warnings: 1, cleanups: 0 }, T0 + 2_000)

    const rows = findingRows()
    expect(rows).toHaveLength(1) // same row, not a second one
    expect(rows[0].resolved_at_ms).toBeNull()
    expect(rows[0].first_seen_ms).toBe(T0) // it remembers when it first appeared
  })

  test('run start/complete envelopes land in the journal', () => {
    const r0 = startRun(db, journal, 'r0', '$1', T0)
    record(db, journal, r0, dirty, T0)
    completeRun(db, journal, r0, { warnings: 1, cleanups: 0 }, T0)

    expect(journal.events()).toEqual([
      'audit.run.started',
      'audit.finding.observed',
      'audit.run.completed',
    ])
  })

  test('counts are recorded on the run', () => {
    const r0 = startRun(db, journal, 'r0', '$1', T0)
    completeRun(db, journal, r0, { warnings: 5, cleanups: 2 }, T0 + 10)

    const r = db.query(`SELECT * FROM audit_runs WHERE id='r0'`).get() as any
    expect([r.warning_count, r.cleanup_count, r.completed_at_ms]).toEqual([5, 2, T0 + 10])
  })

  test('the kind CHECK constraint rejects a finding kind outside the closed enum', () => {
    startRun(db, journal, 'r0', '$1', T0)
    expect(() =>
      db
        .query(
          `INSERT INTO audit_findings (run_id, last_run_id, fingerprint, severity, kind,
                                       first_seen_ms, last_seen_ms)
           VALUES ('r0','r0','fp','warning','vibes',1,1)`,
        )
        .run(),
    ).toThrow()
  })
})
