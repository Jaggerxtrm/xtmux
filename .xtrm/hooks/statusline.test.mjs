import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

const hook = new URL('./statusline.mjs', import.meta.url).pathname;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'xtrm-statusline-'));
  const cwd = join(root, 'repo');
  const cache = join(root, 'cache');
  const beadsRoot = join(root, 'beadsroot');
  const bin = join(root, 'bin');
  const log = join(root, 'calls.log');
  mkdirSync(join(cwd, '.beads'), { recursive: true });
  mkdirSync(cache); mkdirSync(bin); mkdirSync(beadsRoot);
  writeFileSync(join(bin, 'git'), `#!/bin/sh\necho git >> '${log}'\nsleep 0.1\nprintf 'main\\n'\n`);
  // bd returns JSON for --json commands, plain text otherwise. Slow (400ms) — beyond old 250ms timeout.
  writeFileSync(join(bin, 'bd'), `#!/bin/sh
echo bd >> '${log}'
sleep 0.4
case "$*" in
  *"--json"*) printf '[]\\n' ;;
  *) printf '0 open\\n' ;;
esac
`);
  spawnSync('chmod', ['+x', join(bin, 'git'), join(bin, 'bd')]);
  return { root, cwd, cache, beadsRoot, bin, log };
}

function run({ cwd, cache, beadsRoot, bin }) {
  const started = performance.now();
  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ workspace: { current_dir: cwd } }),
    encoding: 'utf8',
    env: {
      ...process.env,
      XTRM_STATUSLINE_CACHE_DIR: cache,
      XTRM_BEADS_CACHE_ROOT: beadsRoot,
      PATH: `${bin}:${process.env.PATH}`,
    },
  });
  return { result, elapsed: performance.now() - started };
}

async function waitForBeadsCache(beadsRoot, timeout = 5_000) {
  const target = join(beadsRoot, '.xtrm', 'cache', 'beads-status.json');
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (existsSync(target)) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('background beads refresh did not finish');
}

test('renderer never blocks; cold fallback + warm cached read both < 200ms', async (t) => {
  const fx = fixture(); t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  const cold = run(fx);
  assert.equal(cold.result.status, 0);
  assert.match(cold.result.stdout, /no open issues|beads unavailable/);
  assert.ok(cold.elapsed < 200, `renderer blocked for ${cold.elapsed}ms`);
  await waitForBeadsCache(fx.beadsRoot);
  const warm = run(fx);
  assert.equal(warm.result.status, 0);
  assert.ok(warm.elapsed < 200, `cached renderer blocked for ${warm.elapsed}ms`);
});

test('slow bd (400ms > old 250ms timeout) still populates cache instead of falling back to zero', async (t) => {
  const fx = fixture(); t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  run(fx);
  await waitForBeadsCache(fx.beadsRoot);
  const cache = JSON.parse(readFileSync(join(fx.beadsRoot, '.xtrm', 'cache', 'beads-status.json'), 'utf8'));
  assert.equal(cache.v, 1);
  assert.deepEqual(cache.counts, { open: 0, in_progress: 0, blocked: 0 });
});

test('concurrent renders share one refresh lease (no bd stampede across N callers)', async (t) => {
  const fx = fixture(); t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  const children = Array.from({ length: 5 }, () => spawn(process.execPath, [hook], {
    stdio: ['pipe', 'ignore', 'ignore'],
    env: {
      ...process.env,
      XTRM_STATUSLINE_CACHE_DIR: fx.cache,
      XTRM_BEADS_CACHE_ROOT: fx.beadsRoot,
      PATH: `${fx.bin}:${process.env.PATH}`,
    },
  }));
  for (const child of children) child.stdin.end(JSON.stringify({ workspace: { current_dir: fx.cwd } }));
  await Promise.all(children.map(child => new Promise((resolve, reject) => child.on('exit', code => code === 0 ? resolve() : reject(new Error(`exit ${code}`))))));
  await waitForBeadsCache(fx.beadsRoot);
  const calls = readFileSync(fx.log, 'utf8').trim().split('\n').filter(Boolean);
  const bdCalls = calls.filter(c => c === 'bd').length;
  assert.ok(bdCalls <= 4, `bd stampede across concurrent renders: ${bdCalls} calls`);
});

test('corrupt beads cache falls back safely without crashing', async (t) => {
  const fx = fixture(); t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  const cacheDir = join(fx.beadsRoot, '.xtrm', 'cache');
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, 'beads-status.json'), '{bad json');
  const { result } = run(fx);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /no open issues|beads unavailable/);
});
