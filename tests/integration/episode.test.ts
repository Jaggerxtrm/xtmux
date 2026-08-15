import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../src/db/connection.ts";
import type { Db } from "../../src/db/connection.ts";
import { migrate } from "../../src/db/schema.ts";
import { openInstance } from "../../src/domains/agents/instance.ts";
import { completeTurn } from "../../src/domains/agents/turn.ts";
import { openEpisode, findLatestEpisode } from "../../src/domains/agents/episode.ts";
import type { Config } from "../../src/config.ts";

function setup(): { db: Db; cleanup: () => void; now: { t: number } } {
  const dir = mkdtempSync(join(tmpdir(), "xtmux-episode-"));
  const cfg: Config = { dbPath: join(dir, "test.db"), mode: "off", busyTimeoutMs: 3000 };
  const db = openDb(cfg);
  migrate(db);
  return {
    db,
    now: { t: 1_000 },
    cleanup: (): void => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function long(text: string): string {
  // Clear the 200-char substantive bar of the episode projection.
  return `${text} ${"y".repeat(230)}`;
}

function openEpisodeState(db: Db, paneId: string): { id: number; closed_at_ms: number | null } | null {
  return db.raw
    .prepare<{ id: number; closed_at_ms: number | null }, [string]>(
      "SELECT id, closed_at_ms FROM agent_episodes WHERE pane_id = ? ORDER BY id DESC LIMIT 1",
    )
    .get(paneId) ?? null;
}

describe("response episodes", () => {
  test("episode.open closes the previous open episode and opens a fresh one", () => {
    const { db, cleanup, now } = setup();
    try {
      const e1 = openEpisode(db, { paneId: "%9", sessionId: "$1", sourceCursor: 100 }, () => ++now.t);
      const e2 = openEpisode(db, { paneId: "%9", sessionId: "$1", sourceCursor: 500 }, () => ++now.t);
      expect(e2).not.toBe(e1);
      const state = openEpisodeState(db, "%9");
      expect(state?.id).toBe(e2);
      expect(state?.closed_at_ms).toBeNull();
      const closed = db.raw
        .prepare<{ closed_at_ms: number | null }, [number]>("SELECT closed_at_ms FROM agent_episodes WHERE id = ?")
        .get(e1);
      expect(closed?.closed_at_ms).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  test("turns attach to the open episode; episode_open=1 starts a fresh one", () => {
    const { db, cleanup, now } = setup();
    try {
      openInstance(db, { instanceId: "inst-A", sessionId: "$1", paneId: "%9", sourceEvent: "launch" }, () => ++now.t);
      const t1 = completeTurn(db, {
        paneId: "%9", sessionId: "$1", summary: "a", lastMessageText: long("response A"),
      }, () => ++now.t);
      const t2 = completeTurn(db, {
        paneId: "%9", sessionId: "$1", summary: "b", lastMessageText: long("follow-up B"),
      }, () => ++now.t);
      const t3 = completeTurn(db, {
        paneId: "%9", sessionId: "$1", summary: "c", lastMessageText: long("response C"),
        episodeOpen: true,
      }, () => ++now.t);

      const rows = db.raw
        .prepare<{ id: number; episode_id: number | null }, []>("SELECT id, episode_id FROM agent_turns ORDER BY id")
        .all();
      expect(rows.map((r) => r.episode_id)).toEqual([rows[0]!.episode_id, rows[0]!.episode_id, rows[2]!.episode_id]);
      expect(rows[2]!.episode_id).not.toBe(rows[0]!.episode_id);
      // The first episode was closed when the third turn opened a fresh one.
      expect(openEpisodeState(db, "%9")?.id).toBe(rows[2]!.episode_id!);
      expect(t1.turnId).not.toBe(0);
      expect(t2.turnId).not.toBe(0);
      expect(t3.turnId).not.toBe(0);
    } finally {
      cleanup();
    }
  });

  test("a turn with no open episode lazy-opens one", () => {
    const { db, cleanup, now } = setup();
    try {
      openInstance(db, { instanceId: "inst-A", sessionId: "$1", paneId: "%9", sourceEvent: "launch" }, () => ++now.t);
      completeTurn(db, { paneId: "%9", sessionId: "$1", summary: "a", lastMessageText: long("solo") }, () => ++now.t);
      const t2 = completeTurn(db, { paneId: "%9", sessionId: "$1", summary: "b", lastMessageText: long("solo 2") }, () => ++now.t);
      const rows = db.raw
        .prepare<{ id: number; episode_id: number | null }, []>("SELECT id, episode_id FROM agent_turns ORDER BY id")
        .all();
      expect(rows[0]!.episode_id).not.toBeNull();
      expect(rows[1]!.episode_id).toBe(rows[0]!.episode_id);
      expect(t2.turnId).toBe(rows[1]!.id);
    } finally {
      cleanup();
    }
  });

  test("an episode opened for another instance does not absorb the new occupant's turn", () => {
    const { db, cleanup, now } = setup();
    try {
      openInstance(db, { instanceId: "inst-A", sessionId: "$1", paneId: "%9", sourceEvent: "launch" }, () => ++now.t);
      openEpisode(db, { paneId: "%9", sessionId: "$1", instanceId: "inst-A" }, () => ++now.t);
      openInstance(db, { instanceId: "inst-B", sessionId: "$1", paneId: "%9", sourceEvent: "launch" }, () => ++now.t);
      completeTurn(db, {
        paneId: "%9", sessionId: "$1", summary: "b", lastMessageText: long("new occupant"),
        instanceId: "inst-B",
      }, () => ++now.t);
      const rows = db.raw
        .prepare<{ id: number; episode_id: number | null }, []>("SELECT id, episode_id FROM agent_turns ORDER BY id")
        .all();
      // inst-B's turn must not land inside inst-A's open episode.
      const episodes = db.raw
        .prepare<{ id: number; instance_id: string | null }, []>("SELECT id, instance_id FROM agent_episodes ORDER BY id")
        .all();
      expect(episodes).toHaveLength(2);
      expect(episodes[1]!.instance_id).toBe("inst-B");
      expect(rows[0]!.episode_id).toBe(episodes[1]!.id);
    } finally {
      cleanup();
    }
  });
  test("findLatestEpisode projects primary, follow-ups, and collapsed acks", () => {
    const { db, cleanup, now } = setup();
    try {
      openInstance(db, { instanceId: "inst-A", sessionId: "$1", paneId: "%9", sourceEvent: "launch" }, () => ++now.t);
      completeTurn(db, { paneId: "%9", sessionId: "$1", summary: "ack", lastMessageText: "Acknowledged." }, () => ++now.t);
      completeTurn(db, { paneId: "%9", sessionId: "$1", summary: "a", lastMessageText: long("primary response") }, () => ++now.t);
      completeTurn(db, { paneId: "%9", sessionId: "$1", summary: "ok", lastMessageText: "ok" }, () => ++now.t);
      completeTurn(db, { paneId: "%9", sessionId: "$1", summary: "b", lastMessageText: long("follow-up") }, () => ++now.t);

      const ep = findLatestEpisode(db, "%9");
      expect(ep).not.toBeNull();
      expect(ep!.primary?.lastMessageText).toBe(long("primary response"));
      expect(ep!.followUps.map((c) => c.lastMessageText)).toEqual([long("follow-up")]);
      expect(ep!.collapsed.map((c) => c.lastMessageText)).toEqual(["Acknowledged.", "ok"]);
      expect(ep!.collapsed.length).toBe(2);

      // Session targets resolve the same way as agent-last.
      expect(findLatestEpisode(db, "$1")?.episodeId).toBe(ep!.episodeId);
    } finally {
      cleanup();
    }
  });

  test("findLatestEpisode falls back to the last text-bearing candidate when nothing is substantive", () => {
    const { db, cleanup, now } = setup();
    try {
      openInstance(db, { instanceId: "inst-A", sessionId: "$1", paneId: "%9", sourceEvent: "launch" }, () => ++now.t);
      completeTurn(db, { paneId: "%9", sessionId: "$1", summary: "first", lastMessageText: "short one" }, () => ++now.t);
      completeTurn(db, { paneId: "%9", sessionId: "$1", summary: "last", lastMessageText: "final word" }, () => ++now.t);
      const ep = findLatestEpisode(db, "%9");
      expect(ep?.primary?.lastMessageText).toBe("final word");
      expect(ep?.followUps).toEqual([]);
      expect(ep?.collapsed.map((c) => c.lastMessageText)).toEqual(["short one"]);
    } finally {
      cleanup();
    }
  });

  test("findLatestEpisode returns null for a pane with no episodes", () => {
    const { db, cleanup } = setup();
    try {
      expect(findLatestEpisode(db, "%9")).toBeNull();
      expect(findLatestEpisode(db, "")).toBeNull();
    } finally {
      cleanup();
    }
  });
});
