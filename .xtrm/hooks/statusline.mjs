#!/usr/bin/env node
// Claude Code statusLine for xt sessions. Rendering only reads a bounded cache;
// a detached, lease-protected refresh performs slow git and beads work.

import { execSync, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, basename, relative, dirname, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const CACHE_DIR = process.env.XTRM_STATUSLINE_CACHE_DIR ?? tmpdir();
const CACHE_TTL = 5000;
const REFRESH_LEASE_MS = 5000;
const RENDER_BUDGET_MS = 50;
const MAX_CACHE_BYTES = 16 * 1024;
const REFRESH_LOCK = join(CACHE_DIR, 'xtrm-sl-refresh.lock');
const BEADS_CACHE = join(CACHE_DIR, 'xtrm-sl-beads.json');

const R = '\x1b[0m', B = '\x1b[1m', B_ = '\x1b[22m', D = '\x1b[2m', I = '\x1b[3m', I_ = '\x1b[23m';

function cacheFile(cwd) {
  const key = createHash('md5').update(cwd).digest('hex').slice(0, 8);
  return join(CACHE_DIR, `xtrm-sl-${key}.json`);
}

function readCache(file) {
  try {
    if (statSync(file).size > MAX_CACHE_BYTES) return null;
    const cache = JSON.parse(readFileSync(file, 'utf8'));
    if (!Number.isFinite(cache?.ts) || !cache?.data || typeof cache.data !== 'object') return null;
    return { data: cache.data, fresh: Date.now() - cache.ts < CACHE_TTL };
  } catch {
    return null;
  }
}

function writeCache(file, data) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify({ ts: Date.now(), data }), { mode: 0o600 });
    renameSync(temp, file);
  } catch {
    try { unlinkSync(temp); } catch {}
  }
}

function run(cwd, cmd) {
  try {
    return execSync(cmd, {
      encoding: 'utf8', cwd, stdio: ['pipe', 'pipe', 'pipe'], timeout: 250,
    }).trim();
  } catch {
    return null;
  }
}

function takeRefreshLease() {
  try {
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

function fallbackData(cwd) {
  return {
    displayDir: cwd.replace(process.env.HOME ?? '', '~'), branch: null, gitFlags: '',
    claims: [], openCount: 0,
  };
}

function readBeads(cwd, mainRoot) {
  const cached = readCache(BEADS_CACHE);
  if (cached?.fresh) return cached.data;

  let claims = [], openCount = 0;
  if (existsSync(join(cwd, '.beads')) || existsSync(join(mainRoot, '.beads'))) {
    const inProgressRaw = run(cwd, 'bd list --status=in_progress') ?? '';
    const ids = [...new Set([...inProgressRaw.matchAll(/^[◐]\s+([a-z][\w-]+)/gm)]
      .map(match => match[1]).filter(id => id.includes('-')))];
    if (ids.length === 1) {
      try {
        const raw = run(cwd, `bd show ${ids[0]} --json`);
        const issue = raw ? JSON.parse(raw)?.[0] : null;
        if (issue) claims.push({ id: ids[0], title: issue.title ?? null, status: issue.status ?? 'in_progress' });
      } catch {}
    } else if (ids.length > 1) {
      claims = ids.map(id => ({ id, title: null, status: 'in_progress' }));
    }
    if (claims.length === 0) {
      const match = run(cwd, 'bd list')?.match(/\((\d+)\s+open/);
      if (match) openCount = Number.parseInt(match[1], 10);
    }
  }
  const data = { claims, openCount };
  writeCache(BEADS_CACHE, data);
  return data;
}

function computeData(cwd) {
  const repoRoot = run(cwd, 'git rev-parse --show-toplevel');
  const gitCommonDir = run(cwd, 'git rev-parse --git-common-dir');
  const mainRoot = gitCommonDir && isAbsolute(gitCommonDir) ? dirname(gitCommonDir) : (repoRoot || cwd);
  const displayDir = repoRoot
    ? (() => { const rel = relative(repoRoot, cwd) || '.'; return rel === '.' ? basename(repoRoot) : `${basename(repoRoot)}/${rel}`; })()
    : cwd.replace(process.env.HOME ?? '', '~');

  let branch = null, gitFlags = '';
  if (repoRoot) {
    branch = run(cwd, 'git -c core.useBuiltinFSMonitor=false branch --show-current') || run(cwd, 'git rev-parse --short HEAD');
    const porcelain = run(cwd, 'git -c core.useBuiltinFSMonitor=false --no-optional-locks status --porcelain') ?? '';
    let modified = false, staged = false, deleted = false;
    for (const line of porcelain.split('\n').filter(Boolean)) {
      if (/^ M|^AM|^MM/.test(line)) modified = true;
      if (/^A |^M /.test(line)) staged = true;
      if (/^ D|^D /.test(line)) deleted = true;
    }
    gitFlags = (modified ? '*' : '') + (staged ? '+' : '') + (deleted ? '-' : '');
    const aheadBehind = run(cwd, 'git -c core.useBuiltinFSMonitor=false --no-optional-locks rev-list --left-right --count @{upstream}...HEAD');
    if (aheadBehind) {
      const [behind, ahead] = aheadBehind.split(/\s+/).map(Number);
      if (ahead > 0 && behind > 0) gitFlags += '↕';
      else if (ahead > 0) gitFlags += '↑';
      else if (behind > 0) gitFlags += '↓';
    }
  }
  return { displayDir, branch, gitFlags, ...readBeads(cwd, mainRoot) };
}

function refresh(cwd) {
  try { writeCache(cacheFile(cwd), computeData(cwd)); } finally { try { unlinkSync(REFRESH_LOCK); } catch {} }
}

function render(ctx, data) {
  const pct = ctx?.context_window?.used_percentage;
  const windowSize = ctx?.context_window?.context_window_size ?? 200000;
  const modelId = ctx?.model?.id ?? null;
  const provider = getProvider(modelId);
  const modelName = ctx?.model?.display_name ?? getModelName(modelId) ?? 'no-model';
  const { displayDir, branch, gitFlags, claims, openCount } = data;

  let line1 = B + displayDir + B_;
  if (branch) line1 += ` ${D}(${gitFlags ? `${branch} ${gitFlags}` : branch})${R}`;
  const pctStr = pct != null ? `${pct.toFixed(1)}%` : '?';
  let modelStr = modelName;
  if (provider) modelStr = `(${provider}) ${modelStr}`;
  const line2 = `${D}${pctStr}/${formatTokens(windowSize)}${R} ${D}${modelStr}${R}`;

  let line3;
  if (!claims?.length) {
    line3 = `○ ${openCount > 0 ? `${B}${openCount}${B_} open` : 'no open issues'}`;
  } else if (claims.length === 1) {
    const { id, title, status } = claims[0];
    const icon = status === 'blocked' ? '●' : status === 'in_progress' ? '◐' : '○';
    const prefix = `${icon} ${id.split('-').pop()} `;
    const max = Math.min((process.stdout.columns || 80) - prefix.length - 1, 40);
    const text = title ? (title.length > max ? `${title.slice(0, max - 1)}…` : title) : '';
    line3 = `${prefix}${I}${text}${I_}`;
  } else {
    line3 = claims.map(({ id, status }) => `${status === 'blocked' ? '●' : '◐'} ${id.split('-').pop()}`).join('  ');
  }
  process.stdout.write(`${line1}\n${line2}\n${line3}\n`);
}

if (process.argv[2] === '--refresh') {
  refresh(process.argv[3] || process.cwd());
} else {
  const started = Date.now();
  let ctx = {};
  try { ctx = JSON.parse(readFileSync(0, 'utf8')); } catch {}
  const cwd = ctx?.workspace?.current_dir ?? process.cwd();
  const cached = readCache(cacheFile(cwd));
  render(ctx, cached?.data ?? fallbackData(cwd));
  if (!cached?.fresh) startRefresh(cwd, started);
}
