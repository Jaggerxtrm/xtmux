// Repo-scoped shared cache for beads status. All agents in the same repo
// (main + linked worktrees, Claude statusline + Pi custom-footer) read/write
// the same file so N agents collapse to 1 bd refresh per TTL.
//
// Zero-I/O readers, single-flight writer via file lease, atomic rename write.
// Import formatCompact() to render the shared one-line spec.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync,
         statSync, unlinkSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join, resolve, sep } from 'node:path';

export const CACHE_VERSION = 1;
export const TTL_COMPACT_MS = 5000;
export const TTL_DESCENDANTS_MS = 30000;
export const LEASE_MS = 5000;
export const BD_TIMEOUT_MS = 2000;
export const GIT_TIMEOUT_MS = 250;
export const MAX_CACHE_BYTES = 32 * 1024;
export const STALE_MARK_AGE_MS = TTL_COMPACT_MS * 10;

const R = '\x1b[0m', B = '\x1b[1m', B_ = '\x1b[22m', D = '\x1b[2m', I = '\x1b[3m', I_ = '\x1b[23m';

export function runFast(cwd, cmd, timeout = GIT_TIMEOUT_MS) {
  try {
    return execSync(cmd, { encoding: 'utf8', cwd, stdio: ['pipe', 'pipe', 'pipe'], timeout }).trim();
  } catch {
    return null;
  }
}

export function runBd(cwd, cmd, timeout = BD_TIMEOUT_MS) {
  return runFast(cwd, cmd, timeout);
}

export function resolveMainRoot(cwd) {
  const override = process.env.XTRM_BEADS_CACHE_ROOT;
  if (override) return override;
  let current = resolve(cwd);
  while (true) {
    const dotGit = join(current, '.git');
    try {
      const stat = statSync(dotGit);
      if (stat.isDirectory()) return current;
      if (stat.isFile()) {
        const match = readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m);
        if (match) {
          const gitDir = resolve(current, match[1].trim());
          const marker = `${sep}.git${sep}worktrees${sep}`;
          const markerIndex = gitDir.indexOf(marker);
          return markerIndex >= 0 ? gitDir.slice(0, markerIndex) : current;
        }
      }
    } catch {}
    const parent = dirname(current);
    if (parent === current) return resolve(cwd);
    current = parent;
  }
}

export function cacheDir(mainRoot) { return join(mainRoot, '.xtrm', 'cache'); }
export function cachePath(mainRoot) { return join(cacheDir(mainRoot), 'beads-status.json'); }
export function lockPath(mainRoot) { return join(cacheDir(mainRoot), 'beads-status.lock'); }

export function readCache(mainRoot) {
  try {
    const file = cachePath(mainRoot);
    if (statSync(file).size > MAX_CACHE_BYTES) return null;
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (!raw || raw.v !== CACHE_VERSION || !Number.isFinite(raw.ts)) return null;
    return raw;
  } catch {
    return null;
  }
}

export function cacheAge(cache) {
  return cache && Number.isFinite(cache.ts) ? Date.now() - cache.ts : Infinity;
}

export function isFresh(cache, ttl = TTL_COMPACT_MS) {
  return cacheAge(cache) < ttl;
}

export function writeCache(mainRoot, data) {
  const dir = cacheDir(mainRoot);
  try { mkdirSync(dir, { recursive: true }); } catch {}
  const file = cachePath(mainRoot);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const payload = JSON.stringify({ v: CACHE_VERSION, ts: Date.now(), stale: false, ...data });
  try {
    writeFileSync(tmp, payload, { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    try { unlinkSync(tmp); } catch {}
  }
}

export function markStale(mainRoot) {
  const current = readCache(mainRoot);
  if (!current) return;
  const dir = cacheDir(mainRoot);
  const file = cachePath(mainRoot);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, JSON.stringify({ ...current, stale: true }), { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    try { unlinkSync(tmp); } catch {}
  }
}

export function takeLease(mainRoot, ttl = LEASE_MS) {
  const dir = cacheDir(mainRoot);
  try { mkdirSync(dir, { recursive: true }); } catch {}
  const file = lockPath(mainRoot);
  try {
    closeSync(openSync(file, 'wx', 0o600));
    return true;
  } catch {
    try {
      if (Date.now() - statSync(file).mtimeMs > ttl) {
        unlinkSync(file);
        return takeLease(mainRoot, ttl);
      }
    } catch {}
    return false;
  }
}

export function releaseLease(mainRoot) {
  try { unlinkSync(lockPath(mainRoot)); } catch {}
}

function bdJson(cwd, cmd) {
  const out = runBd(cwd, cmd);
  if (!out) return null;
  try { return JSON.parse(out); } catch { return null; }
}

export function fetchCompact(cwd) {
  const openList = bdJson(cwd, 'bd list --status=open --json') ?? [];
  const progressList = bdJson(cwd, 'bd list --status=in_progress --json') ?? [];
  const blockedList = bdJson(cwd, 'bd list --status=blocked --json') ?? [];
  const counts = { open: openList.length, in_progress: progressList.length, blocked: blockedList.length };
  const activeIssues = progressList.slice(0, 3).map(i => ({
    id: i.id,
    title: i.title ?? null,
    status: 'in_progress',
    parent: typeof i.parent === 'string' ? i.parent : typeof i.parent_id === 'string' ? i.parent_id : undefined,
  }));

  let activeEpic = null;
  for (const issue of progressList) {
    let parentId = issue.parent_id ?? issue.parent ?? null;
    const seen = new Set();
    while (parentId && !seen.has(parentId) && seen.size < 8) {
      seen.add(parentId);
      const parent = bdJson(cwd, `bd show ${parentId} --json`)?.[0];
      if (!parent) break;
      if (parent.issue_type === 'epic') {
        const children = bdJson(cwd, `bd children ${parentId} --json`) ?? [];
        const closed = children.filter(c => c.status === 'closed').length;
        activeEpic = { id: parent.id, title: parent.title ?? null, closed, total: children.length };
        break;
      }
      parentId = parent.parent_id ?? parent.parent ?? null;
    }
    if (activeEpic) break;
  }
  return { counts, activeIssues, activeEpic };
}

function truncate(s, max) {
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function formatCompact(data, opts = {}) {
  const cols = opts.cols ?? 80;
  const color = opts.color !== false;
  const bold = color ? B : '', _bold = color ? B_ : '';
  const dim = color ? D : '', undim = color ? R : '';
  const ital = color ? I : '', _ital = color ? I_ : '';
  const stale = data?.stale === true;
  const staleTail = stale ? ` ${dim}⋯${undim}` : '';

  if (!data || !data.counts) return `${dim}beads unavailable${undim}`;
  const { open = 0, in_progress = 0, blocked = 0 } = data.counts;

  if (open === 0 && in_progress === 0 && blocked === 0) {
    return `no open issues${staleTail}`;
  }

  const parts = [`${bold}${open}${_bold} open`];
  if (in_progress) parts.push(`${bold}${in_progress}${_bold} in progress`);
  if (blocked) parts.push(`${bold}${blocked}${_bold} blocked`);

  if (cols >= 60) {
    if (data.activeEpic) {
      const { id, closed = 0, total = 0 } = data.activeEpic;
      parts.push(`epic ${id.split('-').pop()} (${closed}/${total} done)`);
    } else if (data.activeIssues?.length === 1) {
      const c = data.activeIssues[0];
      const title = truncate(c.title ?? '', Math.max(20, Math.min(40, cols - 40)));
      parts.push(`working on ${c.id.split('-').pop()}${title ? ` ${ital}${title}${_ital}` : ''}`);
    }
  }

  const line = parts.join(' · ');
  if (stale) {
    const age = cacheAge(data);
    if (Number.isFinite(age) && age > STALE_MARK_AGE_MS) {
      const mins = Math.floor(age / 60000);
      return `${ital}${line}${_ital} ${dim}stale ${mins}m${undim}`;
    }
    return `${ital}${line}${_ital}${staleTail}`;
  }
  return line;
}
