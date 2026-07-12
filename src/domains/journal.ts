/**
 * The event_journal envelope, as seen by domains 4/7/8.
 *
 * Phase 3 (1.1) owns the journal itself. These domains only ever *write* into
 * it, so they take a writer as a parameter rather than importing the module —
 * which is also what lets them be built and tested before Phase 2/3 land.
 * Wiring is then one import at the call site, not a rewrite here.
 */

export interface Envelope {
  domain: 'monitors' | 'telemetry' | 'audit'
  event: string
  /** ties the envelopes of one logical operation together (e.g. command_runs.id) */
  correlationId: string
  outcome?: 'ok' | 'error'
  durationMs?: number
  sessionId?: string | null
  paneId?: string | null
  beadId?: string | null
  detail?: Record<string, unknown>
}

export interface EventJournal {
  write(e: Envelope): void
}

/** Used in tests and while Phase 3 is in flight. Records nothing. */
export const NULL_JOURNAL: EventJournal = { write() {} }

/** Records envelopes in memory — lets the contract tests assert on them. */
export class RecordingJournal implements EventJournal {
  readonly entries: Envelope[] = []
  write(e: Envelope): void {
    this.entries.push(e)
  }
  events(): string[] {
    return this.entries.map((e) => e.event)
  }
}
