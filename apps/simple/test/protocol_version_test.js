/*
 * One protocol version, on both sides of the wire.
 *
 * The car speaks the protocol in car/ros/web_dashboard/web_dashboard/
 * protocol.py (PROTOCOL_VERSION, sent in its `hello`); the page expects
 * SUPPORTED_PROTOCOL_VERSION in apps/simple/web/dashboard.js; the mock car
 * pretends to be a car of some version. They used to live in two repos and
 * could only be kept in step by hand. Now that they share this one, this
 * check makes a bump that lands on one side only fail CI instead of
 * turning the link row red on race day.
 *
 * Oracle: invariant -- all four must be the same integer. The Python file
 * is the source of truth (the car announces it); the rest follow it.
 *
 *     node apps/simple/test/protocol_version_test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');

let checks = 0;
let failures = 0;

function test(name, fn) {
  checks++;
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL  ${name}\n        ${err && err.message ? err.message : err}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// The one integer `pattern` captures in `file` -- which must match exactly
// once, so a renamed or duplicated constant fails here rather than being
// silently skipped.
function versionIn(file, pattern) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const matches = [...text.matchAll(pattern)];
  assert(matches.length === 1,
    `${file}: expected exactly one match of ${pattern}, found ${matches.length}`);
  return Number(matches[0][1]);
}

const SOURCES = {
  car: ['car/ros/web_dashboard/web_dashboard/protocol.py', /^PROTOCOL_VERSION = (\d+)$/gm],
  page: ['apps/simple/web/dashboard.js', /const SUPPORTED_PROTOCOL_VERSION = (\d+);/g],
  mockServer: ['tools/mock-car/server.mjs', /protocol: \{ type: 'string', default: '(\d+)' \}/g],
  mockCar: ['tools/mock-car/car.mjs', /protocolVersion = (\d+),/g],
};

const versions = {};
for (const [side, [file, pattern]] of Object.entries(SOURCES)) {
  test(`${side}: ${file} declares its protocol version exactly once`, () => {
    versions[side] = versionIn(file, pattern);
    assert(Number.isInteger(versions[side]) && versions[side] >= 1,
      `${file}: not a positive integer: ${versions[side]}`);
  });
}

test('the page expects the protocol the car speaks', () => {
  assert(versions.page === versions.car,
    `car/ros/.../protocol.py says ${versions.car}, apps/simple/web/dashboard.js says `
    + `${versions.page} -- bump both in the same change`);
});

test('the mock car speaks the same protocol by default', () => {
  assert(versions.mockServer === versions.car && versions.mockCar === versions.car,
    `protocol.py says ${versions.car}; mock server default ${versions.mockServer}, `
    + `mock car default ${versions.mockCar}`);
});

test("the car's hello carries PROTOCOL_VERSION itself, not a copy of the number", () => {
  const text = fs.readFileSync(path.join(ROOT, SOURCES.car[0]), 'utf8');
  assert(/\{'type': 'hello', 'protocol_version': PROTOCOL_VERSION\}/.test(text),
    "protocol.py's hello no longer sends PROTOCOL_VERSION");
});

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
