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
  | "explicit_stop";
