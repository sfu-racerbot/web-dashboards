/*
 * Runs every test for the simple dashboard under plain node, one process
 * each, the way the car repo's pytest wrappers (test_*_js.py) used to.
 *
 * Each test file prints one line per check and exits non-zero on any
 * failure. This runner additionally insists on the "checks passed" line,
 * exactly as those wrappers did, so a file that exits 0 early without
 * running anything still fails.
 *
 *     node apps/simple/test/run_all.js
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const files = [
  path.join(__dirname, 'web_assets_test.js'),
  path.join(__dirname, 'protocol_version_test.js'),
  ...fs.readdirSync(path.join(__dirname, 'browser'))
    .filter((name) => name.endsWith('_test.js'))
    .sort()
    .map((name) => path.join(__dirname, 'browser', name)),
];

let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: 120000 });
  const ok = result.status === 0 && /checks passed/.test(result.stdout);
  const label = path.relative(path.join(__dirname, '..'), file);
  const summary = (result.stdout.trim().split('\n').pop() || '').trim();
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (${summary})`);
  if (!ok) {
    failed++;
    process.stdout.write(`--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}\n`);
  }
}
console.log(failed ? `\n${failed} of ${files.length} test files failed` : `\nall ${files.length} test files passed`);
process.exit(failed ? 1 : 0);
