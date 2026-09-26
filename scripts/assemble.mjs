#!/usr/bin/env node
// Assemble dist/, the directory Workers Static Assets uploads:
//
//   dist/index.html            <- apps/landing/
//   dist/simple/...            <- apps/simple/web/ (copied as-is: no build step)
//   dist/advanced/...          <- Lichtblick's web build (apps/advanced/build.sh),
//                                 minus source maps, with the team layout injected
//
// Then check every file against the Workers Static Assets limits
// (docs/decisions.md): 25 MiB per file, 20,000 files per version on the
// Free plan. A file over the limit fails the build and is named.
//
//   node scripts/assemble.mjs                    # advanced is optional
//   node scripts/assemble.mjs --require-advanced # CI and deploy: it must be there
//
// LICHTBLICK_WEB_DIR overrides where the Lichtblick build is read from.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const requireAdvanced = process.argv.includes('--require-advanced');

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES = 20_000;
const LAYOUT_PLACEHOLDER = '/*LICHTBLICK_SUITE_DEFAULT_LAYOUT_PLACEHOLDER*/';

function copyDir(from, to, skip = () => false) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (skip(src)) continue;
    if (entry.isDirectory()) copyDir(src, dst, skip);
    else fs.copyFileSync(src, dst);
  }
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push({ file: full, bytes: fs.statSync(full).size });
  }
  return out;
}

const mib = (n) => `${(n / 1024 / 1024).toFixed(2)} MiB`;

/** Put the team's default layout where Lichtblick's Docker image would. */
export function injectLayout(html, layoutJson) {
  if (!html.includes(LAYOUT_PLACEHOLDER)) {
    throw new Error('Lichtblick index.html has no default-layout placeholder; check LICHTBLICK_VERSION');
  }
  // Valid JSON is a valid JS expression; escape "<" so the layout can never
  // close the <script> it sits in.
  const safe = JSON.stringify(JSON.parse(layoutJson)).replace(/</g, '\\u003c');
  return html.replace(LAYOUT_PLACEHOLDER, safe);
}

function main() {
  fs.rmSync(dist, { recursive: true, force: true });
  copyDir(path.join(root, 'apps', 'landing'), dist);
  copyDir(path.join(root, 'apps', 'simple', 'web'), path.join(dist, 'simple'));

  const lichtblick = process.env.LICHTBLICK_WEB_DIR
    || path.join(root, 'apps', 'advanced', '.build', 'lichtblick', 'web', '.webpack');
  const haveAdvanced = fs.existsSync(path.join(lichtblick, 'index.html'));
  if (haveAdvanced) {
    const all = walk(lichtblick);
    console.log(`Lichtblick build: ${all.length} files, ${mib(all.reduce((s, f) => s + f.bytes, 0))}; largest:`);
    for (const f of all.sort((a, b) => b.bytes - a.bytes).slice(0, 8)) {
      console.log(`  ${mib(f.bytes).padStart(10)}  ${path.relative(lichtblick, f.file)}${f.file.endsWith('.map') ? '  (source map, not deployed)' : ''}`);
    }
    // Source maps are only fetched by open devtools; they are over half the
    // build by size and the largest files in it. Not deployed.
    copyDir(lichtblick, path.join(dist, 'advanced'), (src) => src.endsWith('.map'));
    const indexPath = path.join(dist, 'advanced', 'index.html');
    const layout = fs.readFileSync(path.join(root, 'apps', 'advanced', 'layouts', 'racerbot-default.json'), 'utf8');
    fs.writeFileSync(indexPath, injectLayout(fs.readFileSync(indexPath, 'utf8'), layout));
  } else if (requireAdvanced) {
    console.error(`no Lichtblick build at ${lichtblick} -- run apps/advanced/build.sh first`);
    process.exit(1);
  } else {
    console.warn(`note: no Lichtblick build at ${lichtblick}; /<car>/advanced/ will say so. See apps/advanced/README.md.`);
  }

  const files = walk(dist);
  const tooBig = files.filter((f) => f.bytes > MAX_FILE_BYTES);
  console.log(`dist/: ${files.length} files, ${mib(files.reduce((s, f) => s + f.bytes, 0))}; largest deployed:`);
  for (const f of [...files].sort((a, b) => b.bytes - a.bytes).slice(0, 5)) {
    console.log(`  ${mib(f.bytes).padStart(10)}  ${path.relative(dist, f.file)}`);
  }
  let failed = false;
  for (const f of tooBig) {
    console.error(`FAIL: ${path.relative(root, f.file)} is ${mib(f.bytes)}, over the ${mib(MAX_FILE_BYTES)} per-file limit`);
    failed = true;
  }
  if (files.length > MAX_FILES) {
    console.error(`FAIL: ${files.length} files, over the ${MAX_FILES}-file limit (Workers Free)`);
    failed = true;
  }
  if (failed) process.exit(1);
  console.log('asset limits: ok');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
