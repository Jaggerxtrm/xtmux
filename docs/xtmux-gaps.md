# xtmux runtime UI and Specialists integration guidance

Status: implementation guidance and cross-repository integration plan  
Date: 2026-07-14  
Target repositories: `Jaggerxtrm/xtmux`, `xtrm-dev/specialists`  
Primary consumer: xtrm Console materializer and runtime graph

## 1. Purpose

This document defines the missing xtmux contracts required by a graphical Console/Electron viewer and specifies how to represent the following relationship without assuming that a tmux pane starts as, or remains, a Specialists session:

> An agent running in a tmux pane invokes `sp` and spawns one or more Specialists jobs.

The desired graph is:

```text
tmux pane / agent instance
  └─ directly spawned Specialists job
       ├─ child Specialists job
       └─ child Specialists job
```

A pane may never invoke Specialists, may invoke it only after an ordinary interactive session has already started, and may invoke it multiple times. A Specialists chain may in turn spawn additional jobs. The implementation must preserve the difference between direct pane-to-job causality and job-to-job causality.

The complete deliverable covers:

- a complete, versioned tmux topology snapshot;
- cursor-based incremental event consumption;
- a restricted remote bridge suitable for SSH transport;
- explicit readiness and handoff lifecycle semantics;
- stable xtmux event/observability contracts;
- pane/agent-instance to Specialists job causality;
- a read-only-first integration path for Console and Electron.

## 2. Authority boundaries

The two repositories have different responsibilities.

### xtmux owns

- local tmux topology and pane identity;
- the stable identity of the interactive agent instance occupying a pane;
- verified resolution of the current tmux session, window and pane;
- the host identity used to namespace tmux identifiers;
- interactive lifecycle, messages, receipts, handoffs and attention state.

### Specialists owns

- Specialists job allocation and job lifecycle;
- chain and parent-job lineage;
- the durable statement that a job was spawned by a particular runtime origin;
- `xtrm.forensic.v1` events and the Specialists observability database;
- evidence, metrics, evaluations and specialist participant identity.

### Console owns

- materializing the two sources into a read model;
- displaying the pane-to-job and job-to-job edges;
- aggregating active or historical Specialists jobs under a pane.

Console must not infer the relationship from terminal output, PIDs, session names or timing proximity. It consumes the explicit binding produced by Specialists.

## 3. Non-goals

This work must not:

- treat every tmux pane as a Specialists session;
- make xtmux authoritative for Specialists job state;
- make Specialists authoritative for tmux topology;
- overload the existing forensic `correlation.session_id`, which refers to the model/runtime session and not to tmux;
- infer the relationship from `sp-*` tmux session names;
- reconstruct ancestry by polling the process tree;
- screen-scrape terminal content;
- copy Specialists chain, evaluation or evidence semantics into xtmux;
- require Substrate or a new daemon before the bridge can work;
- store job ID lists in pane options as the canonical record;
- make Electron or the Console frontend read source SQLite databases directly;
- store SSH credentials or private keys in application state;
- expose an unrestricted remote shell as the xtmux bridge protocol;
- make the initial viewer depend on interactive terminal input;
- recreate the already shipped SQLite V2 domain store in another repository;
- turn xtmux into the canonical Channels, chain scheduler, judge or evidence store.

## 4. Gap inventory and priority

The SQLite V2 work already provides the durable foundation: typed domain tables for messages, receipts, delivery attempts, agent instances, turns, monitors, handoffs, command telemetry and audit findings. The remaining work is primarily about stable read contracts, causal identity and remote transport.

| Gap | Why it matters | Priority |
|---|---|---|
| Complete topology JSON | The graph cannot reconstruct host → session → window → pane reliably from the current partial dashboard shape | MVP blocker |
| Journal cursor | Polling without a durable cursor causes duplicates, missed events and expensive rereads | MVP blocker |
| Agent-instance identity | A reused pane must not inherit links from its previous occupant | MVP blocker for Specialists binding |
| Pane → Specialists job binding | Console must show which pane spawned which jobs without heuristics | MVP integration blocker |
| Readiness lifecycle | “Pane exists” must be distinguishable from “agent ready” | Required before control actions |
| Existing-file handoff integration | A coordinator needs readiness-aware, monitor-backed delivery | Required before control actions |
| SSH/stdio bridge | Electron needs a bounded way to observe remote xtmux hosts | Remote MVP |
| Structured activity spans | Accurate thinking/tool/turn durations require start/end semantics | Telemetry enhancement |

The recommended initial product remains read-only:

```text
topology snapshot + event updates + read-only pane capture + Specialists links
```

Interactive terminal input and remote mutation should follow only after identity, reconnect and readiness behavior are validated.

## 5. Complete topology JSON contract

### 5.1 Problem

The existing dashboard/list output is useful for operators but does not provide every field needed to reconstruct a stable graph. In particular, the GUI needs window identity, pane placement, active state, geometry, parent relationship and full agent metadata.

Do not make Console parse TSV or call tmux separately. xtmux owns topology and should expose one versioned snapshot.

### 5.2 Command

Preferred command:

```bash
xtmux topology --json
```

Extending `dashboard expanded --json` is acceptable only if it can provide the same complete and stable schema. A dedicated topology command is clearer because dashboard presentation and topology identity evolve for different reasons.

### 5.3 Recommended response

```json
{
  "schema_version": "xtrm.xtmux.topology.v1",
  "generated_at_ms": 1783987200000,
  "host": {
    "host_id": "host-01J2M8GQY8J4Y6T3D3V6",
    "tmux_server_id": "tmux-6a89e1"
  },
  "sessions": [
    {
      "session_id": "$3",
      "name": "specialists-dev",
      "created_at_ms": 1783980000000,
      "activity_at_ms": 1783987190000,
      "attached": true,
      "active": true,
      "windows": [
        {
          "window_id": "@7",
          "window_index": 1,
          "name": "agent",
          "active": true,
          "panes": [
            {
              "pane_id": "%17",
              "pane_index": 0,
              "active": true,
              "width": 160,
              "height": 48,
              "left": 0,
              "top": 0,
              "pid": 31415,
              "current_command": "pi",
              "current_path": "/srv/specialists",
              "agent": {
                "instance_id": "7cc0b27f-41b0-4cae-b6e8-6929035bbb44",
                "state": "running",
                "bead_id": "specialists-123",
                "task": "review runtime bridge",
                "prompt_file": "/tmp/review-runtime.md",
                "parent_session_id": "$1",
                "last_transition": "2026-07-14T02:39:50+02:00"
              }
            }
          ]
        }
      ]
    }
  ]
}
```

### 5.4 Required semantics

- IDs must use tmux stable IDs: `$N`, `@N`, `%N`.
- Names and indexes are display metadata, not identity.
- Include `window_id`, `window_index`, `pane_index`, `active`, geometry and current path/command.
- Include `@agent_parent_session`; it is currently missing from the pane-level JSON needed by the graph.
- Include `@agent_instance_id`, `@agent_state`, `@agent_bead`, `@agent_task`, `@agent_prompt_file` and `@agent_last_transition` when available.
- Include `host_id` in every snapshot and make the tmux server identity explicit or derivable.
- Missing optional metadata must serialize as absent or `null`, never as a fabricated value.
- JSON output must remain presentation-free and backward compatible within `v1`.
- The snapshot command is read-only and bounded. Pane content is not part of this response.

### 5.5 Read-only pane capture

Use a separate bounded operation for terminal previews:

```bash
xtmux pane capture --pane %17 --lines 200 --json
```

The response should include pane identity, capture timestamp, truncation information and ANSI content. The first Console implementation may render the capture read-only. Interactive xterm input is not required for the initial graph viewer.

## 6. Cursor-based event journal

### 6.1 Problem

An event key is not a reliable stream cursor, especially when it is optional or domain-specific. Console needs the monotonically increasing `event_journal.id` so it can reconnect and request only committed events it has not consumed.

### 6.2 Query contract

Extend the log query contract:

```bash
xtmux log query --after-id 1842 --limit 500 --json
```

Recommended response:

```json
{
  "schema_version": "xtrm.xtmux.journal-page.v1",
  "items": [
    {
      "journal_id": 1843,
      "event_key": "optional-domain-idempotency-key",
      "event_type": "message.delivered",
      "occurred_at_ms": 1783987200000,
      "recorded_at_ms": 1783987200020,
      "host_id": "host-01J2M8GQY8J4Y6T3D3V6",
      "session_id": "$3",
      "pane_id": "%17",
      "agent_instance_id": "7cc0b27f-41b0-4cae-b6e8-6929035bbb44",
      "payload": {}
    }
  ],
  "next_after_id": 1843,
  "oldest_available_id": 1200,
  "latest_available_id": 1843,
  "has_more": false
}
```

### 6.3 Cursor rules

- `journal_id` is the committed SQLite row ID and is always present.
- Results are ordered strictly by `journal_id ASC`.
- `--after-id N` is exclusive: the first result must have `journal_id > N`.
- Pagination must not use timestamps as the primary cursor.
- `event_key` remains an optional idempotency/correlation field and is not a substitute for `journal_id`.
- `next_after_id` is the highest returned ID, or the requested cursor when the page is empty.
- Expose `oldest_available_id` so a consumer can detect retention-related cursor expiry.
- Return a structured cursor-expired response when `after-id` predates retained history.
- WebSocket or stdio notifications are hints after commit; the consumer advances its cursor only from committed query results.

### 6.4 Optional follow mode

After the page contract is stable, add:

```bash
xtmux log follow --after-id 1843 --json
```

Each line should be one committed journal item. On reconnect, the consumer resumes with the last successfully materialized `journal_id`. A follow stream must not introduce a second event schema.

## 7. Restricted remote bridge for SSH

### 7.1 Boundary

Electron should use the system OpenSSH client and the user's existing `~/.ssh/config`, ssh-agent or platform keychain. It must not implement its own SSH stack or store private keys/passwords.

The remote command should be fixed:

```bash
ssh <host-alias> xtmux bridge --stdio
```

stdout is reserved for framed protocol messages; stderr is reserved for bounded diagnostics.

### 7.2 Protocol

Use newline-delimited JSON with request IDs and capability negotiation.

Handshake example:

```json
{"id":"1","method":"bridge.hello","params":{"client_version":"1.0.0","read_only":true}}
```

```json
{
  "id":"1",
  "result":{
    "schema_version":"xtrm.xtmux.bridge.v1",
    "host_id":"host-01J2M8GQY8J4Y6T3D3V6",
    "capabilities":[
      "topology.snapshot",
      "journal.query",
      "journal.follow",
      "pane.capture"
    ]
  }
}
```

Initial read-only methods:

```text
bridge.hello
topology.snapshot
journal.query
journal.follow
pane.capture
health.get
```

Later, separately permissioned methods may include:

```text
pane.input
message.send
message.ack
handoff.send
monitor.register
```

### 7.3 Requirements

- No arbitrary command execution method.
- Enforce maximum line/frame size and bounded result sizes.
- Validate every request against a versioned schema.
- Request IDs correlate responses; notifications have explicit event method names.
- A malformed request must not terminate the bridge process unless framing is unrecoverable.
- Support graceful EOF and cancellation.
- All resource IDs are scoped by the bridge's `host_id`.
- Reconnect uses topology refresh plus the last committed journal cursor.
- Read-only mode must reject every mutation even when the remote xtmux binary supports it.
- The bridge reads existing xtmux APIs and SQLite-backed contracts; it does not create another database.

### 7.4 Deployment

The remote host needs only the normal xtmux installation plus the bridge command. A long-running daemon is not required for the first version. If Console/`xt daemon` is already reachable over Tailscale, Electron may connect directly to its HTTP/WebSocket API and use SSH only for the interactive tmux plane.

## 8. Readiness and handoff completion

### 8.1 Readiness lifecycle

Creating a pane or starting a process is not proof that the agent can receive work. Add an explicit startup handshake:

```text
starting → agent.ready → idle
```

Recommended events:

```text
agent.instance.started
agent.ready
agent.state.changed
agent.instance.ended
```

`agent.ready` should be emitted once per `agent_instance_id` after the relevant Pi/Claude runtime has completed initialization and installed its control hooks. It must be distinct from `idle`, which can recur after turns.

### 8.2 Handoff of an existing prompt file

Extend handoff so callers can provide an already-created prompt file rather than forcing xtmux to generate one:

```bash
xtmux handoff \
  --target %17 \
  --prompt-file /tmp/task.md \
  --wait-ready 2m \
  --monitor \
  --json
```

Requirements:

- validate that the prompt file is an allowed local path and exists before delivery;
- wait for the target's `agent.ready` when requested;
- preserve dry-run-first behavior unless the explicit send/approval flag is present;
- create one durable handoff record before delivery;
- record every delivery attempt and its result;
- optionally register a monitor transactionally with the handoff intent;
- make retries idempotent through a caller-provided or generated handoff key;
- never treat `tmux send-keys` success as proof that the agent accepted or completed the work.

### 8.3 UI behavior

Console may enable read-only viewing before readiness is implemented. Actions such as input, approve, interrupt or handoff should remain disabled or explicitly experimental until the readiness and delivery contracts are available.

## 9. xtmux observability and event completeness

### 9.1 Stable event envelope

The event journal should expose a stable envelope independent of individual domain payloads:

```ts
export interface XtmuxJournalEventV1 {
  schema_version: 'xtrm.xtmux.event.v1';
  journal_id: number;
  event_type: string;
  event_version: number;
  occurred_at_ms: number;
  recorded_at_ms: number;
  event_key?: string;
  host_id: string;
  tmux_server_id?: string;
  session_id?: string;
  window_id?: string;
  pane_id?: string;
  agent_instance_id?: string;
  bead_id?: string;
  correlation?: Record<string, string>;
  payload: Record<string, unknown>;
}
```

Every event required by the graph must carry enough identity to attach it without reading current pane options after the fact.

### 9.2 Required event families

At minimum, normalize and document:

```text
topology.session.created / closed
topology.window.created / closed
topology.pane.created / closed
agent.instance.started / ended
agent.ready
agent.state.changed
agent.turn.completed
message.sent / delivered / acknowledged / failed
handoff.created / delivery_attempted / delivered / failed
monitor.started / heartbeat / completed / timed_out / killed
command.started / completed / failed
audit.finding.recorded / resolved
```

Existing domain tables remain authoritative for domain state. The journal is the ordered integration feed.

### 9.3 Structured activity spans

The current compact thinking representation is insufficient for exact duration metrics when it records only cumulative character counts. As a telemetry enhancement, represent start/end spans without storing raw thinking content:

```ts
interface AgentActivitySpanEvent {
  phase: 'start' | 'end';
  segment_id: string;
  turn_index?: number;
  activity: 'thinking' | 'tool' | 'text';
  duration_ms?: number;
  char_count?: number;
}
```

This enables `thinking_stream_duration_ms`, segment counts and time-to-first-activity. It must be described as observed stream duration, not provider compute time. This work is not a blocker for the topology viewer.

### 9.4 Bounded queries and retention

- Every list/query endpoint needs an explicit limit and deterministic ordering.
- Retention must preserve active agent instances, unacknowledged messages, incomplete delivery attempts, active monitors and unresolved findings.
- Cursor expiry is a normal protocol outcome, not an unstructured database error.
- UI consumers must fetch details on demand instead of receiving an unbounded historical dump.

## 10. Already solved or intentionally out of scope

The implementation should not reopen problems already addressed by SQLite V2. In particular, the design should reuse:

- transactional message and receipt persistence;
- indexed recipient and unread queries;
- delivery attempts;
- durable agent instances and state transitions;
- turns, monitors, handoffs, telemetry and audit findings;
- retention/compaction and migration machinery.

Older JSONL limitations such as O(N) polling, ack orphaning during rotation and mixed-event scans are historical migration concerns, not reasons to create another store. The remaining task is to expose the SQLite-backed data through complete contracts.

xtmux must also not grow into the future Channels authority. Transactional per-channel semantics, participant/job authority levels, typed work verdicts, scheduler indirection, stop conditions, judge semantics, chain topology and canonical evidence remain outside this implementation.

## 11. Shared runtime-origin contract

xtmux should expose a small, versioned description of the current interactive origin. Specialists records it when a job is allocated.

Recommended TypeScript shape:

```ts
export interface RuntimeOriginV1 {
  schema_version: 'xtrm.runtime-origin.v1';
  kind: 'xtmux.agent_instance';
  host_id: string;
  tmux_server_id?: string;
  tmux_session_id: string;
  tmux_window_id: string;
  tmux_pane_id: string;
  agent_instance_id?: string;
  bead_id?: string;
  parent_session_id?: string;
  captured_at_ms: number;
  capture_source: 'xtmux-context' | 'propagated';
  verified: boolean;
}
```

Semantics:

- `host_id` namespaces every tmux identifier and must not expose `/etc/machine-id` directly. xtmux should persist a generated UUID in its own state.
- `tmux_session_id`, `tmux_window_id` and `tmux_pane_id` are tmux stable IDs such as `$3`, `@7` and `%17`, not mutable names or indexes.
- `agent_instance_id` identifies one agent occupation of a pane. It is more precise than `tmux_pane_id`, because a pane may later be reused.
- `verified=true` means xtmux resolved the pane against the active tmux socket at capture time.
- Absence of `agent_instance_id` is allowed during migration. Such a binding has pane-level rather than agent-instance-level precision.

Do not reuse `xtrm.forensic.v1` itself as the request/response schema for xtmux. `RuntimeOriginV1` is a small identity DTO; it is embedded later into a forensic event owned by Specialists.

## 12. Specialists-link changes in `Jaggerxtrm/xtmux`

### 12.1 Add a stable agent-instance identity

Add the pane-scoped option:

```text
@agent_instance_id
```

The identity should be a UUID generated when a new interactive agent session begins. It should be overwritten for a new agent session even if the same pane is reused.

Suggested integration points:

- `scripts/agent-state.sh`
- `extensions/pi-agent-state.ts`
- Claude/Codex hook examples and installation documentation

One backward-compatible interface is:

```bash
agent-state.sh idle --new-instance
```

Expected behavior:

- `--new-instance` generates a UUID and writes `@agent_instance_id` before the state event is emitted;
- ordinary state transitions preserve the existing instance ID;
- `off` may leave the last instance ID for post-mortem inspection, because the next `--new-instance` overwrites it;
- absence of UUID tooling must not fail an agent turn. `/proc/sys/kernel/random/uuid`, `uuidgen`, or a Bun helper may be used with a tested fallback;
- lifecycle hooks remain best-effort and bounded in latency.

For Pi, invoke the new-instance path on `session_start`. For Claude, invoke it on `SessionStart`. Do not generate a new identity on every `idle` transition.

### 12.2 Add a current-context JSON command

Add a read-only command with a stable JSON contract:

```bash
xtmux context --current --json
```

Example output:

```json
{
  "schema_version": "xtrm.runtime-origin.v1",
  "kind": "xtmux.agent_instance",
  "host_id": "host-01J2M8GQY8J4Y6T3D3V6",
  "tmux_server_id": "tmux-6a89e1",
  "tmux_session_id": "$3",
  "tmux_window_id": "@7",
  "tmux_pane_id": "%17",
  "agent_instance_id": "7cc0b27f-41b0-4cae-b6e8-6929035bbb44",
  "bead_id": "specialists-123",
  "parent_session_id": "$1",
  "captured_at_ms": 1783987200000,
  "capture_source": "xtmux-context",
  "verified": true
}
```

Implementation requirements:

- require a real tmux invocation context: both `TMUX` and `TMUX_PANE`;
- resolve the target explicitly using `-t "$TMUX_PANE"`;
- obtain IDs with tmux formats such as `#{session_id}`, `#{window_id}` and `#{pane_id}`;
- read `@agent_instance_id`, `@agent_bead` and `@agent_parent_session` from the current pane;
- never use `#S` or window/pane indexes as identity;
- return a structured non-zero error outside tmux or when the pane cannot be verified;
- keep the command read-only. It must not lazily create an agent instance;
- emit no human decoration in JSON mode.

Suggested implementation locations, adjusted to the repository's current layout:

```text
src/cli.ts
src/commands/context.ts
src/domains/identity/runtime-context.ts
scripts/agent-state.sh
extensions/pi-agent-state.ts
docs/agent-state-hooks.md
test/contract.sh
```

### 12.3 Host and tmux-server identity

Persist an xtmux-specific `host_id` under the normal xtmux state directory. Generate it once and reuse it across restarts. Do not derive a public identifier directly from machine-id.

`tmux_server_id` is optional in the first implementation if `agent_instance_id` is always available. If implemented, derive or persist it per tmux server/socket lifetime. The minimum reliable matching key is:

```text
host_id + agent_instance_id
```

The fallback during migration is:

```text
host_id + tmux_session_id + tmux_pane_id + captured_at_ms
```

### 12.4 No canonical Specialists registry in xtmux

Do not add Specialists status, chain state or evidence to the xtmux database as authoritative data. Console can join xtmux topology with Specialists forensic events.

An optional future `specialist.job.spawned` attention hint in xtmux may exist, but it must be explicitly documented as a non-authoritative notification and is not required by this integration.

## 13. Changes in `xtrm-dev/specialists`

### 13.1 Capture origin at the invocation boundary

Capture the origin at the start of `sp run`, before handling `--background` and before creating any `sp-*` tmux session.

Suggested new module:

```text
src/specialist/runtime-origin.ts
```

Responsibilities:

- invoke `xtmux context --current --json` with a short timeout;
- validate `schema_version`, required fields and identifier formats;
- return `undefined` outside tmux or when xtmux is unavailable;
- never fail a Specialists run merely because no runtime origin exists;
- retain a diagnostic reason for debug logging without persisting sensitive command details.

The top-level call belongs near the start of `src/cli/run.ts`:

```ts
const ambientRuntimeOrigin = captureRuntimeOrigin();
```

It must occur before the `args.background` branch.

### 13.2 Preserve origin through background detachment

When `sp run --background` creates a new tmux session, the new session's `TMUX_PANE` represents the Specialists feed/runtime pane, not the invoking pane. Therefore the original context must be serialized and explicitly propagated.

Recommended environment variable:

```text
SPECIALISTS_RUNTIME_ORIGIN_V1
```

The value may be compact JSON when passed as a process environment entry. If it must cross a shell command string, use base64url-encoded JSON and decode it with strict validation.

Requirements:

- the outer `sp run --background` captures the origin once;
- `createTmuxSession` passes that exact origin to the detached child;
- the child marks `capture_source='propagated'` while preserving `verified=true` from the original capture;
- the child must not replace the propagated origin with its own `sp-*` pane;
- malformed propagated values are ignored and diagnosed, not trusted.

### 13.3 Add spawn lineage to job state

Extend the relevant job/run types:

```ts
export type SpecialistSpawnOriginV1 =
  | {
      kind: 'xtmux.agent_instance';
      runtime_origin: RuntimeOriginV1;
    }
  | {
      kind: 'specialist.job';
      parent_job_id: string;
    }
  | {
      kind: 'unknown';
    };

export interface SupervisorStatus {
  // existing fields...
  spawn_origin?: SpecialistSpawnOriginV1;
  parent_job_id?: string;
  root_runtime_origin?: RuntimeOriginV1;
}
```

Also add the relevant fields to `RunOptions`, `startup_context` and the `run_start` timeline event.

Suggested files:

```text
src/cli/run.ts
src/specialist/launch.ts
src/specialist/runner.ts
src/specialist/supervisor.ts
src/specialist/timeline-events.ts
```

`SupervisorStatus.tmux_session` and `SPECIALISTS_TMUX_SESSION` must retain their existing meaning. They describe the Specialists-owned tmux session used for background execution/feed and must not be repurposed as the caller pane.

### 13.4 Direct origin versus child-job origin

Use this precedence when allocating a job:

1. If an explicit `parent_job_id` is present, the direct origin is `specialist.job`.
2. Otherwise, if a validated propagated runtime origin exists, use it.
3. Otherwise, capture the ambient xtmux context.
4. Otherwise, store no binding or `kind='unknown'`; never infer one.

For a direct job launched from a pane:

```text
spawn_origin.kind = xtmux.agent_instance
root_runtime_origin = the same pane origin
parent_job_id = undefined
```

For a child job launched by another Specialists job:

```text
spawn_origin.kind = specialist.job
parent_job_id = direct parent job
root_runtime_origin = inherited from the root job, if available
```

Internal launch sites such as node supervision, script execution or chain coordination must pass `parent_job_id` explicitly. They must not rely on inherited `TMUX_PANE`, otherwise every descendant would incorrectly appear as directly spawned by the original pane.

Review at least these launch paths:

```text
src/specialist/node-supervisor.ts
src/specialist/script-runner.ts
src/specialist/job-control.ts
src/tools/specialist/
src/cli/node.ts
src/cli/chat.ts
```

### 13.5 Enrich `xtrm.forensic.v1` `job.started`

The existing `run_start` → `job.started` mapping is the canonical emission point. Do not create an unrelated parallel event family.

Extend the typed forensic model so that `job.started` can contain:

```json
{
  "schema_version": "xtrm.forensic.v1",
  "event_family": "job",
  "event_name": "job.started",
  "correlation": {
    "job_id": "a81c2f",
    "parent_job_id": "optional-parent-job",
    "chain_id": "a81c2f",
    "bead_id": "specialists-123"
  },
  "links": {
    "spawned_by": {
      "kind": "xtmux.agent_instance",
      "host_id": "host-01J2M8GQY8J4Y6T3D3V6",
      "tmux_session_id": "$3",
      "tmux_window_id": "@7",
      "tmux_pane_id": "%17",
      "agent_instance_id": "7cc0b27f-41b0-4cae-b6e8-6929035bbb44"
    },
    "root_runtime_origin": {
      "kind": "xtmux.agent_instance",
      "host_id": "host-01J2M8GQY8J4Y6T3D3V6",
      "tmux_pane_id": "%17",
      "agent_instance_id": "7cc0b27f-41b0-4cae-b6e8-6929035bbb44"
    }
  },
  "body": {
    "launch_mode": "background",
    "origin_source": "xtmux-context",
    "origin_verified": true
  }
}
```

For a child job, `links.spawned_by` changes to:

```json
{
  "kind": "specialist.job",
  "job_id": "parent-job-id"
}
```

Required code changes:

- add `parent_job_id?: string` to `ForensicCorrelation` as a typed field;
- add it to `FORBIDDEN_PROMETHEUS_LABELS` because it is high-cardinality;
- define typed forensic link structures instead of relying solely on `Record<string, unknown>`;
- add runtime origin fields to `TimelineForensicContext` or obtain them from the persisted status in `readForensicContext`;
- special-case `run_start` in `bodyForTimelineEvent` so origin metadata is not buried only inside `legacy_timeline_event`;
- preserve redaction rules and never include raw prompts, commands or terminal output.

Relevant files:

```text
src/specialist/forensic-events.ts
src/specialist/observability-sqlite.ts
src/specialist/timeline-events.ts
```

### 13.6 Persistence model

Persist the origin in both forms:

1. `SupervisorStatus` / `specialist_jobs.status_json` for current-state inspection, recovery and `sp ps --json`.
2. The immutable `xtrm.forensic.v1` `job.started` event for downstream materialization and historical reconstruction.

These are not competing authorities. The status row is a mutable projection; the forensic event is the canonical historical statement.

The existing `specialist_forensic_events` table already stores `event_json` and indexes job sequence and event family/name/time. The first implementation therefore does not require new origin columns. Add indexed columns only if source-side queries by pane become a measured requirement.

The write order must remain transactional where the current observability client already writes status plus `run_start`. Console must never observe a forensic spawn event for a job that was not successfully allocated.

### 13.7 CLI visibility

Expose the binding in existing JSON output, especially `sp ps <job> --json` and status reads. Human output may show a compact line such as:

```text
spawned-by host-01 / $3:%17 / agent 7cc0b27f
```

Do not print a misleading pane association when runtime origin is absent.

## 14. Console materialization contract

No Console implementation is required in these two PRs, but the output must support the following projection:

```ts
export interface RuntimeSpawnBinding {
  specialist_job_id: string;
  parent_job_id?: string;
  relation: 'spawned';
  host_id?: string;
  tmux_session_id?: string;
  tmux_window_id?: string;
  tmux_pane_id?: string;
  agent_instance_id?: string;
  root_agent_instance_id?: string;
  spawned_at_ms: number;
  source_schema: 'xtrm.forensic.v1';
  source_event_name: 'job.started';
}
```

Console should materialize the binding from `specialist_forensic_events`, then join it to live xtmux topology using:

1. `host_id + agent_instance_id` when available;
2. pane identity only as a degraded fallback;
3. no inferred edge when neither can be matched.

If the source pane has disappeared, Console may retain a historical or ghost node because the forensic relationship remains valid.

## 15. Failure behavior

The integration is optional metadata and must not block normal Specialists execution.

| Condition | Required behavior |
|---|---|
| `sp run` outside tmux | Run normally, no pane binding |
| xtmux not installed | Run normally, record diagnostic only |
| malformed xtmux JSON | Reject origin, run normally |
| `TMUX_PANE` cannot be resolved | No binding; never guess |
| `agent_instance_id` missing | Persist verified pane-level origin |
| background launch | Preserve original pane, never bind to `sp-*` pane |
| internal child job | Bind to parent job and inherit root pane origin |
| source pane closes | Keep forensic binding; live topology may mark it historical |
| pane reused | New agent instance ID prevents association with the old occupant |

## 16. Security and privacy

- Do not include prompt text, terminal capture, raw commands, SSH credentials or environment dumps.
- Validate all propagated JSON and apply size limits before parsing.
- Do not accept arbitrary user-supplied `verified=true`; only xtmux context resolution may produce a verified ambient origin.
- Do not turn runtime IDs into Prometheus labels. Keep `job_id`, `parent_job_id`, pane IDs and instance IDs in forensic correlation/links and Console read models.
- Treat tmux names and indexes as display values only, never authority.
- The command used by Specialists must be fixed (`xtmux context --current --json`), not a shell-composed arbitrary command.

## 17. Implementation sequence

### PR A — xtmux topology and identity contracts

1. Add persistent non-sensitive `host_id`.
2. Add complete `xtmux topology --json`.
3. Add bounded `xtmux pane capture`.
4. Add `@agent_instance_id` lifecycle handling.
5. Add `xtmux context --current --json`.
6. Update Pi/Claude hook integrations.
7. Add topology, context and lifecycle contract tests.

This PR can merge independently. Older Specialists versions simply do not consume the new identity command.

### PR B — xtmux journal cursor

1. Expose `journal_id` on every JSON event.
2. Add exclusive `--after-id` pagination.
3. Add low/high watermark metadata and cursor-expiry behavior.
4. Add deterministic bounded queries.
5. Add follow mode only after page semantics are validated.

### PR C — xtmux readiness and handoff completion

1. Implement the `agent.ready` handshake for Pi and Claude.
2. Add existing-prompt-file handoff.
3. Add readiness wait and monitor integration.
4. Preserve dry-run and idempotent delivery behavior.
5. Add restart and retry tests.

### PR D — xtmux SSH bridge

1. Implement `bridge.hello` and capability negotiation.
2. Expose topology, journal query/follow and pane capture in read-only mode.
3. Add framing, limits, cancellation and reconnect tests.
4. Defer mutation capabilities to a later separately reviewed PR.

### PR E — Specialists direct spawn binding

1. Add `RuntimeOriginV1` validation.
2. Capture origin before the background branch.
3. Propagate origin to detached execution.
4. Store origin in `SupervisorStatus` and `run_start`.
5. Enrich forensic `job.started`.
6. Expose origin through JSON status output.

### PR F — Specialists descendant lineage

1. Add explicit `parent_job_id` propagation to every internal launch path.
2. Preserve `root_runtime_origin` across the chain.
3. Emit child `job.started` events with `spawned_by=specialist.job`.
4. Add multi-level chain tests.

### Later Console PR

Materialize `job.started` links, join them to xtmux topology and render pane-to-job and job-to-job edges. This must remain a read-model/UI change, not source ingestion inside the frontend.

## 18. Acceptance criteria

### xtmux

- `xtmux topology --json` reconstructs host → session → window → pane with stable IDs and complete pane metadata.
- Pane objects include window/pane indexes, active state, geometry and `@agent_parent_session`.
- `log query --after-id` returns strictly ordered committed rows without duplicates.
- A consumer can detect and recover from cursor expiry after retention.
- The read-only stdio bridge exposes only negotiated bounded methods.
- SSH transport requires no credentials stored by Electron.
- `agent.ready` is distinct from pane/process creation and from recurring `idle`.
- Existing-file handoff can wait for readiness and register a monitor.
- `xtmux context --current --json` returns stable IDs for the exact invoking pane.
- The command fails cleanly outside tmux and never selects a bystander tmux server.
- Starting a new agent in a reused pane produces a new `agent_instance_id`.
- Ordinary state transitions do not rotate `agent_instance_id`.
- Existing agent-state hooks remain backward compatible.

### Specialists

- A foreground `sp run` invoked from a normal agent pane emits `job.started` linked to that pane/agent instance.
- A background `sp run` remains linked to the invoking pane, not to the newly created `sp-*` pane.
- Two jobs launched from one pane produce two independent job edges sharing the same origin instance.
- A child job records `parent_job_id` and `spawned_by=specialist.job`, while retaining the root pane origin.
- A run outside tmux produces no fabricated binding and otherwise behaves identically.
- `sp ps --json` exposes the stored origin.
- Existing forensic consumers continue to parse events without requiring the new links.
- Origin identifiers never appear as Prometheus labels.

### End-to-end fixture

The integration test should demonstrate:

```text
agent instance A in pane %17
  -> starts executor job J1 in background
  -> J1 starts reviewer job J2
```

Expected durable relationships:

```text
J1 spawned_by xtmux.agent_instance A
J1 root_runtime_origin A
J2 spawned_by specialist.job J1
J2 parent_job_id J1
J2 root_runtime_origin A
```

After process restart, the same relationships must be reconstructable from `specialist_forensic_events` without inspecting the terminal or live process tree.

## 19. Suggested tests

### xtmux tests

- topology JSON schema, nesting and stable identifiers;
- window/pane index, active state and geometry coverage;
- journal exclusive cursor, empty page, pagination and retention expiry;
- committed-event ordering across domain event types;
- follow reconnect without duplicates;
- bridge handshake, framing, limits and read-only rejection of mutations;
- readiness ordering and exactly-once `agent.ready` per instance;
- existing-file handoff, timeout, retry and monitor linkage;
- context JSON schema and exact field names;
- stable tmux IDs rather than names/indexes;
- outside-tmux error;
- stale/dead pane rejection;
- new agent instance generation;
- preservation across ordinary lifecycle transitions;
- replacement on a new session in the same pane;
- host ID persistence;
- no secrets or environment dump in output.

### Specialists tests

- runtime-origin schema validation;
- ambient capture success and failure;
- background propagation round trip;
- malformed propagated value rejection;
- precedence of `parent_job_id` over ambient pane origin;
- root-origin inheritance;
- `SupervisorStatus` serialization compatibility;
- `run_start` timeline serialization;
- `job.started` forensic link mapping;
- redaction and forbidden-label enforcement;
- SQLite transaction and recovery behavior;
- legacy job rows and forensic events without origin.

## 20. Final design decision

The canonical statement is produced by Specialists:

```text
Specialists job J was spawned by runtime origin R at time T.
```

xtmux supplies and verifies `R`; Specialists owns `J` and persists the causal link in `xtrm.forensic.v1`; Console materializes and displays it.

For the graphical viewer, xtmux additionally provides complete topology, a committed journal cursor, bounded pane capture and a restricted remote bridge. Console remains a materialized read model over these contracts.

This keeps the repositories independent, supports panes that invoke Specialists only later in their lifetime, handles multiple jobs and nested chains, permits remote SSH observation, and avoids brittle inference or a fourth control plane.
