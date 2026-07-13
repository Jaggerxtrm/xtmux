import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const mod = await import(new URL('./beads-status-cache.mjs', import.meta.url).pathname);

function fixture() {
  const mainRoot = mkdtempSync(join(tmpdir(), 'xtrm-beads-cache-'));
  return { mainRoot, cleanup: () => rmSync(mainRoot, { recursive: true, force: true }) };
}

test('writeCache stamps version + ts and readCache round-trips', async (t) => {
  const fx = fixture(); t.after(fx.cleanup);
  const data = { counts: { open: 5, in_progress: 2, blocked: 0 }, activeIssues: [], activeEpic: null };
  mod.writeCache(fx.mainRoot, data);
  const cache = mod.readCache(fx.mainRoot);
  assert.equal(cache.v, mod.CACHE_VERSION);
  assert.equal(cache.counts.open, 5);
  assert.ok(Number.isFinite(cache.ts));
  assert.equal(cache.stale, false);
});

test('readCache rejects mismatched schema version', async (t) => {
  const fx = fixture(); t.after(fx.cleanup);
  mkdirSync(join(fx.mainRoot, '.xtrm', 'cache'), { recursive: true });
  writeFileSync(mod.cachePath(fx.mainRoot), JSON.stringify({ v: 999, ts: Date.now(), counts: {} }));
  assert.equal(mod.readCache(fx.mainRoot), null);
});

test('readCache rejects corrupt JSON', async (t) => {
  const fx = fixture(); t.after(fx.cleanup);
  mkdirSync(join(fx.mainRoot, '.xtrm', 'cache'), { recursive: true });
  writeFileSync(mod.cachePath(fx.mainRoot), '{not json');
  assert.equal(mod.readCache(fx.mainRoot), null);
});

test('isFresh honors TTL', async (t) => {
  const fx = fixture(); t.after(fx.cleanup);
  mod.writeCache(fx.mainRoot, { counts: { open: 1 } });
  assert.equal(mod.isFresh(mod.readCache(fx.mainRoot)), true);
  const stale = { ...mod.readCache(fx.mainRoot), ts: Date.now() - 60_000 };
  assert.equal(mod.isFresh(stale), false);
});

test('takeLease is single-flight; releaseLease frees it', async (t) => {
  const fx = fixture(); t.after(fx.cleanup);
  assert.equal(mod.takeLease(fx.mainRoot), true, 'first holder wins');
  assert.equal(mod.takeLease(fx.mainRoot), false, 'second is refused');
  mod.releaseLease(fx.mainRoot);
  assert.equal(mod.takeLease(fx.mainRoot), true, 'released lease is reacquirable');
});

test('markStale flips stale flag without losing data', async (t) => {
  const fx = fixture(); t.after(fx.cleanup);
  mod.writeCache(fx.mainRoot, { counts: { open: 3, in_progress: 1, blocked: 0 } });
  mod.markStale(fx.mainRoot);
  const cache = mod.readCache(fx.mainRoot);
  assert.equal(cache.stale, true);
  assert.equal(cache.counts.open, 3);
});

test('XTRM_BEADS_CACHE_ROOT overrides resolveMainRoot', async (t) => {
  const fx = fixture(); t.after(fx.cleanup);
  const orig = process.env.XTRM_BEADS_CACHE_ROOT;
  process.env.XTRM_BEADS_CACHE_ROOT = fx.mainRoot;
  t.after(() => { if (orig == null) delete process.env.XTRM_BEADS_CACHE_ROOT; else process.env.XTRM_BEADS_CACHE_ROOT = orig; });
  assert.equal(mod.resolveMainRoot('/tmp/does-not-matter'), fx.mainRoot);
});

test('resolveMainRoot converges a linked worktree onto the main repository without git', async (t) => {
  const fx = fixture(); t.after(fx.cleanup);
  const main = join(fx.mainRoot, 'main');
  const worktree = join(fx.mainRoot, 'worktree');
  mkdirSync(join(main, '.git', 'worktrees', 'feature'), { recursive: true });
  mkdirSync(worktree);
  writeFileSync(join(worktree, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'feature')}\n`);
  assert.equal(mod.resolveMainRoot(worktree), main);
});

test('fetchCompact walks nested parents to the owning epic and includes closed children', async (t) => {
  const fx = fixture(); t.after(fx.cleanup);
  const bin = join(fx.mainRoot, 'bin');
  mkdirSync(bin);
  const bd = join(bin, 'bd');
  writeFileSync(bd, `#!/bin/sh
case "$*" in
  "list --status=open --json") printf '[]' ;;
  "list --status=in_progress --json") printf '[{"id":"xtrm-standalone","title":"Standalone","status":"in_progress"},{"id":"xtrm-epic.1.1","title":"Nested","status":"in_progress","parent":"xtrm-epic.1"}]' ;;
  "list --status=blocked --json") printf '[]' ;;
  "show xtrm-epic.1 --json") printf '[{"id":"xtrm-epic.1","issue_type":"task","parent":"xtrm-epic"}]' ;;
  "show xtrm-epic --json") printf '[{"id":"xtrm-epic","title":"Epic","issue_type":"epic"}]' ;;
  "children xtrm-epic --json") printf '[{"id":"xtrm-epic.1","status":"open"},{"id":"xtrm-epic.2","status":"closed"}]' ;;
  *) exit 1 ;;
esac
`);
  chmodSync(bd, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; });

  const compact = mod.fetchCompact(fx.mainRoot);
  assert.equal(compact.activeEpic.id, 'xtrm-epic');
  assert.equal(compact.activeEpic.closed, 1);
  assert.equal(compact.activeEpic.total, 2);
});

test('formatCompact: zero-issue', () => {
  const line = mod.formatCompact({ counts: { open: 0, in_progress: 0, blocked: 0 } }, { color: false });
  assert.equal(line, 'no open issues');
});

test('formatCompact: counts + activeEpic', () => {
  const line = mod.formatCompact({
    counts: { open: 12, in_progress: 2, blocked: 0 },
    activeEpic: { id: 'xtrm-k2ufi', title: 'foo', closed: 1, total: 3 },
  }, { color: false });
  assert.equal(line, '12 open · 2 in progress · epic k2ufi (1/3 done)');
});

test('formatCompact: single claim without epic uses clear text', () => {
  const line = mod.formatCompact({
    counts: { open: 5, in_progress: 1, blocked: 0 },
    activeEpic: null,
    activeIssues: [{ id: 'xtrm-y0tdg', title: 'refactor skill layout', status: 'in_progress' }],
  }, { color: false });
  assert.match(line, /^5 open · 1 in progress · working on y0tdg refactor skill layout$/);
});

test('formatCompact: stale marker adds trailing ⋯', () => {
  const line = mod.formatCompact({
    counts: { open: 3, in_progress: 0, blocked: 0 },
    stale: true,
  }, { color: false });
  assert.match(line, /⋯$/);
});

test('formatCompact: narrow terminal drops epic clause', () => {
  const line = mod.formatCompact({
    counts: { open: 12, in_progress: 2, blocked: 0 },
    activeEpic: { id: 'xtrm-k2ufi', title: 'foo', closed: 1, total: 3 },
  }, { color: false, cols: 40 });
  assert.equal(line, '12 open · 2 in progress');
});

test('formatCompact: null data yields unavailable placeholder', () => {
  assert.match(mod.formatCompact(null, { color: false }), /beads unavailable/);
  assert.match(mod.formatCompact({ v: 1 }, { color: false }), /beads unavailable/);
});
