/*
 * Checks for web/apex.js -- Manual Apex Mode's logic.
 *
 * apex.js is pure (no DOM, canvas or WebSocket), so the real file is loaded
 * under plain node and called for real; nothing is mocked.
 *
 * Oracles:
 *   closed form  -- nearest waypoints and arc lengths recomputed here from
 *                   hand-built lines whose geometry is known
 *   invariant    -- the input list is never mutated; a fingerprint changes
 *                   when the line changes and only then
 *   boundary     -- separation exactly at the minimum, and just under it
 *
 * Run with `node apex_test.js`, or `node apps/simple/test/run_all.js`.
 */
'use strict';

const path = require('path');

const apex = require(path.join(__dirname, '..', '..', 'web', 'apex.js'));

let checks = 0;
let failures = 0;

function check(name, condition, detail) {
  checks++;
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  }
}
function near(name, actual, expected, tol) {
  check(name, Math.abs(actual - expected) <= tol, `expected ${expected} +/- ${tol}, got ${actual}`);
}

// An L-shaped line: (0,0) -> (1,0) -> (2,0) -> (2,1) -> (2,2), 1 m segments.
const L = { closed: false, points: [[0, 0, 1.0], [1, 0, 1.5], [2, 0, 2.0], [2, 1, 1.5], [2, 2, 1.0]] };
const map = (x, y) => ({ frame: 'map', x, y });

// --- frame ---------------------------------------------------------------
{
  const r = apex.addApex([], { frame: 'body', x: 0.5, y: 0.2 }, L);
  check('a body-frame tap is refused, not converted', !r.added && r.apexes.length === 0);
  check('the refusal says why', /map frame/.test(r.reason), r.reason);
  check('a tap with no coordinates is refused', !apex.addApex([], { frame: 'map', x: NaN, y: 0 }, L).added);
}

// --- association with the line (closed form) -------------------------------
{
  const r = apex.addApex([], map(2.3, 0.9), L);              // nearest waypoint is (2, 1), index 3
  const a = r.apexes[0];
  check('a map-frame tap is added', r.added && r.apexes.length === 1);
  check('it is tied to the nearest waypoint', a.waypoint_index === 3, `got ${a.waypoint_index}`);
  near('arc length to that waypoint is 3 m (three 1 m segments)', a.s_m, 3.0, 1e-12);
  near('distance to the line is hypot(0.3, 0.1)', a.distance_to_line_m, Math.hypot(0.3, 0.1), 1e-12);
  check('the tap position is kept as tapped, not snapped to the line', a.x === 2.3 && a.y === 0.9);
  const first = apex.nearestWaypoint(L.points, -5, 0);
  check('before the start, the first waypoint is nearest (s = 0)', first.index === 0 && first.s === 0);
}
{
  const r = apex.addApex([], map(1, 1), null);
  check('with no racing line the apex is kept, unassociated',
    r.added && r.apexes[0].waypoint_index === null && r.apexes[0].s_m === null);
  check('an empty line gives no association', apex.nearestWaypoint([], 0, 0) === null);
}

// --- separation boundary -----------------------------------------------------
{
  const one = apex.addApex([], map(0, 0), L).apexes;
  const at = apex.addApex(one, map(apex.MIN_SEPARATION_M, 0), L);
  const under = apex.addApex(one, map(apex.MIN_SEPARATION_M - 1e-6, 0), L);
  check('exactly the minimum separation away is a second apex', at.added && at.apexes.length === 2);
  check('just under it is the same tap twice', !under.added && /too close/.test(under.reason));
}

// --- immutability, undo ---------------------------------------------------------
{
  const before = apex.addApex([], map(0, 0), L).apexes;
  const snapshot = JSON.stringify(before);
  const after = apex.addApex(before, map(1, 0), L).apexes;
  check('adding never mutates the list it was given', JSON.stringify(before) === snapshot && after.length === 2);
  const undone = apex.undo(after);
  check('undo removes the last apex only', undone.length === 1 && undone[0].x === 0);
  check('undo on nothing is nothing', apex.undo([]).length === 0 && apex.undo(null).length === 0);
}

// --- ordering and export ---------------------------------------------------------
{
  let list = [];
  list = apex.addApex(list, map(2.1, 1.9), L).apexes;        // s = 4
  list = apex.addApex(list, map(0.9, 0.1), L).apexes;        // s = 1
  list = apex.addApex(list, map(9, 9), null).apexes;         // unassociated
  const doc = apex.exportDocument(list, L, { created: '2026-11-06T00:00:00Z', car: 'rb1' });
  check('export is tagged with its format and the map frame',
    doc.format === apex.FORMAT && doc.version === apex.VERSION && doc.frame === 'map');
  check('exported apexes run along the line, unassociated last',
    doc.apexes.map((a) => a.s_m).join(',') === '1,4,', JSON.stringify(doc.apexes.map((a) => a.s_m)));
  check('export carries the line fingerprint', doc.line.points === 5 && /^[0-9a-f]{8}$/.test(doc.line.fnv1a));
  check('the export says it is not a command', /Not a command/.test(doc.note));
  check('export survives a JSON round trip', JSON.stringify(JSON.parse(JSON.stringify(doc))) === JSON.stringify(doc));
}

// --- fingerprint changes with the line, and only then ------------------------------------
{
  const f1 = apex.lineFingerprint(L);
  const same = apex.lineFingerprint({ closed: false, points: L.points.map((p) => p.slice()) });
  const moved = apex.lineFingerprint({ closed: false, points: L.points.map((p, i) => (i === 2 ? [p[0] + 0.002, p[1], p[2]] : p)) });
  const speedOnly = apex.lineFingerprint({ closed: false, points: L.points.map((p) => [p[0], p[1], 9]) });
  check('the same geometry gives the same fingerprint', f1.fnv1a === same.fnv1a);
  check('moving one point by 2 mm changes it', f1.fnv1a !== moved.fnv1a);
  check('a speed-only change does not (apexes are about geometry)', f1.fnv1a === speedOnly.fnv1a);
}

console.log('');
if (failures) {
  console.log(`${failures} of ${checks} checks FAILED`);
  process.exit(1);
}
console.log(`${checks} checks passed`);
