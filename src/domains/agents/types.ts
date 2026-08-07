export interface AgentInstanceRow {
  instance_id: string;
  session_id: string;
  session_name: string | null;
  pane_id: string;
  runtime: string | null;
  role: string | null;
  bead_id: string | null;
  task: string | null;
  prompt_file: string | null;
  parent_session_id: string | null;
  started_at_ms: number;
  ended_at_ms: number | null;
  end_reason: string | null;
  last_state: string | null;
  last_transition_ms: number | null;
}

export type EndReason =
  | "session_shutdown"
  | "state_off"
  | "pane_gone"
  | "killed"
  | "explicit_stop"
  // K4 (xtmux-s96.4): a NEW occupation opened on a pane that still had an
  // active one. The previous agent left without a lifecycle end event — a
  // crash, a `kill-session`, or a harness restart that reused the pane — so
  // its instance is closed by the successor rather than left open forever.
  | "superseded";
