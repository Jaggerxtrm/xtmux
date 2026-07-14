import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * host_id namespaces every tmux identifier ($3, @7, %17) across machines, so a
 * consumer joining xtmux topology to Specialists forensic events can tell two
 * hosts' pane %17 apart.
 *
 * It is a generated UUID persisted in xtmux's own state dir. It is deliberately
 * NOT derived from /etc/machine-id: that would publish a stable fingerprint of
 * the host into every forensic event we hand to another repository.
 *
 * Kept byte-compatible with the `host_id()` shell function in
 * scripts/agent-state.sh — both read and create the same file, so a hook and
 * the CLI never disagree about who this host is.
 */
export function hostIdPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["XTMUX_HOST_ID_FILE"];
  if (override) return override;
  const stateHome = env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state");
  return join(stateHome, "xtmux", "host-id");
}

export function hostId(env: NodeJS.ProcessEnv = process.env): string {
  const path = hostIdPath(env);
  const existing = read(path);
  if (existing) return existing;

  mkdirSync(dirname(path), { recursive: true });
  try {
    // wx: fail if it already exists. Two panes starting at once must agree on
    // one id, not race each other into overwriting it.
    writeFileSync(path, `${randomUUID()}\n`, { flag: "wx" });
  } catch {
    // Lost the race (or the dir is unwritable) — fall through to the reread.
  }
  const settled = read(path);
  if (settled) return settled;
  throw new Error(`xtmux: cannot persist host_id at ${path}`);
}

function read(path: string): string | null {
  try {
    const value = readFileSync(path, "utf8").trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}
