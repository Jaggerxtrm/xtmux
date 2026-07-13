#!/usr/bin/env node
// Claude Code statusLine for xt sessions. Rendering only reads bounded caches;
// a detached, lease-protected refresh performs slow git + beads work.
// Beads data comes from the repo-scoped shared cache in beads-status-cache.mjs
// so N agents in the same repo collapse to one bd refresh per TTL.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync,
         statSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, basename, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  runFast, resolveMainRoot, readCache as readBeadsCache, isFresh, writeCache as writeBeadsCache,
  takeLease as takeBeadsLease, releaseLease as releaseBeadsLease,
  fetchCompact, formatCompact, cacheAge, TTL_COMPACT_MS,
} from './beads-status-cache.mjs';

const CACHE_DIR = process.env.XTRM_STATUSLINE_CACHE_DIR ?? tmpdir();
const GIT_CACHE_TTL = 5000;
const REFRESH_LEASE_MS = 5000;
const RENDER_BUDGET_MS = 50;
const MAX_CACHE_BYTES = 16 * 1024;
const REFRESH_LOCK = join(CACHE_DIR, 'xtrm-sl-refresh.lock');

const R = '\x1b[0m', B = '\x1b[1m', B_ = '\x1b[22m', D = '\x1b[2m';

function cacheFile(cwd) {
  const key = createHash('md5').update(cwd).digest('hex').slice(0, 8);
  return join(CACHE_DIR, `xtrm-sl-git-${key}.json`);
}

function readGitCache(file) {
  try {
    if (statSync(file).size > MAX_CACHE_BYTES) return null;
    const cache = JSON.parse(readFileSync(file, 'utf8'));
    if (!Number.isFinite(cache?.ts) || !cache?.data || typeof cache.data !== 'object') return null;
    return { data: cache.data, fresh: Date.now() - cache.ts < GIT_CACHE_TTL };
  } catch {
    return null;
  }
}

function writeGitCache(file, data) {
  try { mkdirSync(CACHE_DIR, { recursive: true }); } catch {}
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify({ ts: Date.now(), data }), { mode: 0o600 });
    renameSync(temp, file);
  } catch {
    try { unlinkSync(temp); } catch {}
  }
}

function takeRefreshLease() {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const fd = openSync(REFRESH_LOCK, 'wx', 0o600);
    closeSync(fd);
    return true;
  } catch {
    try {
      if (Date.now() - statSync(REFRESH_LOCK).mtimeMs > REFRESH_LEASE_MS) {
        unlinkSync(REFRESH_LOCK);
        return takeRefreshLease();
      }
    } catch {}
    return false;
  }
}

function startRefresh(cwd, started) {
  if (Date.now() - started >= RENDER_BUDGET_MS || !takeRefreshLease()) return;
  try {
    const child = spawn(process.execPath, [process.argv[1], '--refresh', cwd], {
      cwd, detached: true, stdio: 'ignore', env: process.env,
    });
    child.unref();
  } catch {
    try { unlinkSync(REFRESH_LOCK); } catch {}
  }
}

function formatTokens(count) {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function getProvider(modelId) {
  return modelId?.includes('/') ? modelId.split('/')[0] : null;
}

function getModelName(modelId) {
  return modelId?.includes('/') ? modelId.split('/')[1] : modelId ?? null;
}

function fallbackGit(cwd) {
  return {
    displayDir: cwd.replace(process.env.HOME ?? '', '~'), branch: null, gitFlags: '',
  };
}

function computeGit(cwd, mainRoot) {
  const repoRoot = runFast(cwd, 'git rev-parse --show-toplevel');
  const displayDir = repoRoot
    ? (() => { const rel = relative(repoRoot, cwd) || '.'; return rel === '.' ? basename(repoRoot) : `${basename(repoRoot)}/${rel}`; })()
    : cwd.replace(process.env.HOME ?? '', '~');

  let branch = null, gitFlags = '';
  if (repoRoot) {
    branch = runFast(cwd, 'git -c core.useBuiltinFSMonitor=false branch --show-current')
      || runFast(cwd, 'git rev-parse --short HEAD');
    const porcelain = runFast(cwd, 'git -c core.useBuiltinFSMonitor=false --no-optional-locks status --porcelain') ?? '';
    let modified = false, staged = false, deleted = false;
    for (const line of porcelain.split('\n').filter(Boolean)) {
      if (/^ M|^AM|^MM/.test(line)) modified = true;
      if (/^A |^M /.test(line)) staged = true;
      if (/^ D|^D /.test(line)) deleted = true;
    }
    gitFlags = (modified ? '*' : '') + (staged ? '+' : '') + (deleted ? '-' : '');
    const aheadBehind = runFast(cwd, 'git -c core.useBuiltinFSMonitor=false --no-optional-locks rev-list --left-right --count @{upstream}...HEAD');
    if (aheadBehind) {
      const [behind, ahead] = aheadBehind.split(/\s+/).map(Number);
      if (ahead > 0 && behind > 0) gitFlags += '↕';
      else if (ahead > 0) gitFlags += '↑';
      else if (behind > 0) gitFlags += '↓';
    }
  }
  return { displayDir, branch, gitFlags, mainRoot };
}

function refresh(cwd) {
  try {
    const mainRoot = resolveMainRoot(cwd);
    writeGitCache(cacheFile(cwd), computeGit(cwd, mainRoot));
    if (takeBeadsLease(mainRoot)) {
      try {
        const beads = fetchCompact(cwd);
        writeBeadsCache(mainRoot, beads);
      } finally {
        releaseBeadsLease(mainRoot);
      }
    }
  } finally {
    try { unlinkSync(REFRESH_LOCK); } catch {}
  }
}

function render(ctx, git, beadsCache, cwd) {
  const pct = ctx?.context_window?.used_percentage;
  const windowSize = ctx?.context_window?.context_window_size ?? 200000;
  const modelId = ctx?.model?.id ?? null;
  const provider = getProvider(modelId);
  const modelName = ctx?.model?.display_name ?? getModelName(modelId) ?? 'no-model';
  const { displayDir, branch, gitFlags } = git;
  const cols = process.stdout.columns || 80;

  let line1 = B + displayDir + B_;
  if (branch) line1 += ` ${D}(${gitFlags ? `${branch} ${gitFlags}` : branch})${R}`;
  const pctStr = pct != null ? `${pct.toFixed(1)}%` : '?';
  let modelStr = modelName;
  if (provider) modelStr = `(${provider}) ${modelStr}`;
  const line2 = `${D}${pctStr}/${formatTokens(windowSize)}${R} ${D}${modelStr}${R}`;

  const line3 = formatCompact(beadsCache, { cols });
  process.stdout.write(`${line1}\n${line2}\n${line3}\n`);
}

if (process.argv[2] === '--refresh') {
  refresh(process.argv[3] || process.cwd());
} else {
  const started = Date.now();
  let ctx = {};
  try { ctx = JSON.parse(readFileSync(0, 'utf8')); } catch {}
  const cwd = ctx?.workspace?.current_dir ?? process.cwd();
  const gitCached = readGitCache(cacheFile(cwd));
  const git = gitCached?.data ?? fallbackGit(cwd);

  const mainRoot = gitCached?.data?.mainRoot ?? resolveMainRoot(cwd);
  const beadsCache = readBeadsCache(mainRoot);
  const beadsFresh = isFresh(beadsCache);

  render(ctx, git, beadsCache, cwd);

  if (!gitCached?.fresh || !beadsFresh) startRefresh(cwd, started);
}
