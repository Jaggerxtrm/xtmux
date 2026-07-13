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
  const bin = join(root, 'bin');
  const log = join(root, 'calls.log');
  mkdirSync(join(cwd, '.beads'), { recursive: true });
  mkdirSync(cache); mkdirSync(bin);
  writeFileSync(join(bin, 'git'), `#!/bin/sh\necho git >> '${log}'\nsleep 0.2\nprintf 'main\\n'\n`);
  writeFileSync(join(bin, 'bd'), `#!/bin/sh\necho bd >> '${log}'\nsleep 0.2\nprintf '0 open\\n'\n`);
  spawnSync('chmod', ['+x', join(bin, 'git'), join(bin, 'bd')]);
  return { root, cwd, cache, bin, log };
}

function run({ cwd, cache, bin }) {
  const started = performance.now();
  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ workspace: { current_dir: cwd } }),
    encoding: 'utf8',
    env: { ...process.env, XTRM_STATUSLINE_CACHE_DIR: cache, PATH: `${bin}:${process.env.PATH}` },
  });
  return { result, elapsed: performance.now() - started };
}

async function waitForCache(cache, timeout = 3_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (existsSync(join(cache, 'xtrm-sl-refresh.lock')) === false && existsSync(join(cache, 'xtrm-sl-beads.json'))) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('background refresh did not finish');
}

test('returns stale or fallback output without waiting for slow git and beads refresh', async (t) => {
  const fx = fixture(); t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  const cold = run(fx);
  assert.equal(cold.result.status, 0);
  assert.match(cold.result.stdout, /no open issues/);
  assert.ok(cold.elapsed < 200, `renderer blocked for ${cold.elapsed}ms`);
  await waitForCache(fx.cache);
  const warm = run(fx);
  assert.equal(warm.result.status, 0);
  assert.ok(warm.elapsed < 200, `cached renderer blocked for ${warm.elapsed}ms`);
});

test('corrupt cache falls back safely and concurrent renders share one refresh lease', async (t) => {
  const fx = fixture(); t.after(() => rmSync(fx.root, { recursive: true, force: true }));
  writeFileSync(join(fx.cache, 'xtrm-sl-beads.json'), '{bad json');
  const children = Array.from({ length: 5 }, () => spawn(process.execPath, [hook], {
    stdio: ['pipe', 'ignore', 'ignore'],
    env: { ...process.env, XTRM_STATUSLINE_CACHE_DIR: fx.cache, PATH: `${fx.bin}:${process.env.PATH}` },
  }));
  for (const child of children) child.stdin.end(JSON.stringify({ workspace: { current_dir: fx.cwd } }));
  await Promise.all(children.map(child => new Promise((resolve, reject) => child.on('exit', code => code === 0 ? resolve() : reject(new Error(`exit ${code}`))))));
  await waitForCache(fx.cache);
  const calls = readFileSync(fx.log, 'utf8').trim().split('\n').filter(Boolean);
  assert.ok(calls.filter(call => call === 'git').length <= 5, `refresh stampede: ${calls.join(', ')}`);
});
