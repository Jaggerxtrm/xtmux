#!/usr/bin/env node
// Refresh the [Unreleased] section of CHANGELOG.md from the git log.
//
// Ported from core/specialists' scripts/changelog-update.mjs. Adapted for xtmux:
//   - resolves git-cliff from the npm dep (import.meta.resolve('git-cliff/cli')),
//     mirroring scripts/changelog.mjs — no global git-cliff install needed.
//   - version headers on xtmux drop the leading v (## [0.2.0], not ## [v0.2.0]),
//     so the safety-net regex is adjusted accordingly.
//
// Why this exists instead of `git-cliff --prepend`:
//   --prepend blindly inserts at line 1. That would put the generated block
//   ABOVE the "# Changelog" title (stranding it mid-file) and stack a SECOND
//   [Unreleased] section on top of the existing one. Every run would make it worse.
//
// This script is idempotent: it replaces the [Unreleased] section in place, keeping
// the title/preamble at the top and every released section untouched. Run it twice,
// get the same file.
//
// It never uses `git-cliff -o` / plain generate — those rebuild CHANGELOG.md from the
// git log and would drop every hand-written line (release prose, etc.).
//
//   node scripts/changelog-update.mjs [--check] [--tag vX.Y.Z]
//     --check       exit 1 if the file would change (CI guard), write nothing
//     --tag vX.Y.Z  promote unreleased commits into a versioned section
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHANGELOG = join(root, 'CHANGELOG.md');
const CONFIG = join(root, 'changelog', 'cliff.toml');
const UNRELEASED = '## [Unreleased]';
const check = process.argv.includes('--check');
const tagIndex = process.argv.indexOf('--tag');
const tag = tagIndex === -1 ? undefined : process.argv[tagIndex + 1];
if (tagIndex !== -1 && !tag) throw new Error('--tag requires a version');

const current = readFileSync(CHANGELOG, 'utf8');

// The header is everything before the first section heading (title + preamble + rule).
const firstSection = current.search(/^## \[/m);
if (firstSection === -1) throw new Error(`${CHANGELOG}: no "## [" section found — refusing to guess its shape.`);
const header = current.slice(0, firstSection).trimEnd();

// A file already corrupted by `git-cliff --prepend` has its "# Changelog" title BELOW the
// injected [Unreleased] block, so "everything above the first section" is empty and the title
// would be dropped along with that block. Refuse rather than silently delete it.
if (!/^# /m.test(header)) {
  throw new Error(
    `${CHANGELOG}: no "# " title above the first section — the file looks --prepend-corrupted.\n` +
    `Restore the title/preamble to the top of the file, then re-run.`,
  );
}

const cliff = fileURLToPath(import.meta.resolve('git-cliff/cli'));
const cliffArgs = [cliff, '--config', CONFIG, '--unreleased'];
if (tag) cliffArgs.push('--tag', tag);
const result = spawnSync(process.execPath, cliffArgs, {
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
  cwd: root,
});
if (result.status !== 0) {
  console.error(result.stderr || `git-cliff exit ${result.status}`);
  process.exit(result.status ?? 1);
}
// xtmux cliff.toml emits the full CHANGELOG.md (title + preamble + section).
// We only want the [Unreleased] section onwards — everything above would
// duplicate the file's existing header.
const rawGenerated = result.stdout.trim();
const unrelIdx = rawGenerated.indexOf(UNRELEASED);
const generated = unrelIdx === -1 ? rawGenerated : rawGenerated.slice(unrelIdx).trim();

// Released sections = everything from the first "## [" that is NOT [Unreleased].
// Dropping the target version too keeps tagged runs idempotent.
const sections = current.slice(firstSection).split(/^(?=## \[)/m);
const targetHeading = tag ? `## [${tag.replace(/^v/, '')}]` : undefined;
const released = sections
  .filter((section) => !section.startsWith(UNRELEASED) && (!targetHeading || !section.startsWith(targetHeading)))
  .join('')
  .trimEnd();

const hasEntries = /^- /m.test(generated);
const refreshed = tag
  ? `${UNRELEASED}\n\n${generated}`
  : generated.startsWith(UNRELEASED) ? generated : `${UNRELEASED}\n\n${generated}`;
const next = `${header}\n\n${hasEntries ? refreshed : UNRELEASED}\n\n${released}\n`;

if (next === current) {
  console.log(`${CHANGELOG}: already up to date`);
  process.exit(0);
}
if (check) {
  console.error(`${CHANGELOG}: out of date — run: node scripts/changelog-update.mjs${tag ? ` --tag ${tag}` : ''}`);
  process.exit(1);
}

// Safety net: never lose a released section. xtmux uses ## [X.Y.Z] (no v prefix).
for (const heading of current.match(/^## \[\d[^\]]*\].*$/gm) ?? []) {
  if (!next.includes(heading)) throw new Error(`refusing to write: would drop released section ${heading}`);
}

writeFileSync(CHANGELOG, next);
console.log(`${CHANGELOG}: ${tag ?? '[Unreleased]'} refreshed (${(generated.match(/^- /gm) ?? []).length} entries)`);
