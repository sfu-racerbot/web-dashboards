/*
 * apex.js -- the logic behind the dashboard's Manual Apex Mode.
 *
 * Manual Apex Mode is an OFFLINE path-editing aid: you tap where you want the
 * racing line's apexes to be, and the page records them, tied to the racing
 * line it is showing, so they can be saved and handed to the line editor and
 * the pure pursuit tuner. A tap never sends anything to the car and never
 * issues a steering command; this file has no WebSocket, DOM or canvas at all.
 *
 * Everything here is PURE, like measure.js: dashboard.js owns the pointer
 * events, drawing and sidebar; this file owns the decisions and the
 * arithmetic, so test/browser/apex_test.js can require() it under plain node.
 *
 * Rules:
 *  - Map frame only. A body-frame position ("0.8 m left of where the car is
 *    now") is not a place on the track, so it is refused, not converted.
 *  - Each apex is associated with the nearest waypoint of the racing line on
 *    screen: its index, the arc length along the line to it, and how far the
 *    tap is from the line. With no line, the apex is kept unassociated.
 *  - The export carries a fingerprint of that line, so an apex file can never
 *    be silently applied to a different line.
 */
(function () {
  'use strict';

  const FORMAT = 'racerbot-apexes';
  const VERSION = 1;
  /** Two apexes closer than this (metres) are the same tap twice. */
  const MIN_SEPARATION_M = 0.05;

  function isMapPoint(p) {
    return !!p && p.frame === 'map' && Number.isFinite(p.x) && Number.isFinite(p.y);
  }

  /** Line points as [[x, y, ...], ...] -> {index, s, distance} of the nearest one, or null. */
  function nearestWaypoint(points, x, y) {
    if (!Array.isArray(points) || points.length === 0) return null;
    let best = -1;
    let bestD2 = Infinity;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
      const dx = p[0] - x;
      const dy = p[1] - y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; best = i; }
    }
    if (best < 0) return null;
    let s = 0;
    for (let i = 1; i <= best; i++) {
      s += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    }
    return { index: best, s, distance: Math.sqrt(bestD2) };
  }

  /** FNV-1a over the line's points rounded to the millimetre, plus its length in points. */
  function lineFingerprint(line) {
    const pts = (line && Array.isArray(line.points)) ? line.points : [];
    let h = 0x811c9dc5;
    for (const p of pts) {
      const text = `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)};`;
      for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
    }
    return { points: pts.length, closed: !!(line && line.closed), fnv1a: h.toString(16).padStart(8, '0') };
  }

  /**
   * Add a tapped point. Returns { apexes, added, reason }: a new list (the
   * input is never mutated) and, when nothing was added, why.
   */
  function addApex(apexes, point, line) {
    const list = Array.isArray(apexes) ? apexes : [];
    if (!isMapPoint(point)) {
      return { apexes: list, added: false,
               reason: 'apexes need the map frame: wait for a localization pose' };
    }
    for (const a of list) {
      if (Math.hypot(a.x - point.x, a.y - point.y) < MIN_SEPARATION_M) {
        return { apexes: list, added: false, reason: 'too close to an existing apex' };
      }
    }
    const pts = line && Array.isArray(line.points) ? line.points : null;
    const near = pts ? nearestWaypoint(pts, point.x, point.y) : null;
    const apex = {
      x: point.x,
      y: point.y,
      waypoint_index: near ? near.index : null,
      s_m: near ? near.s : null,
      distance_to_line_m: near ? near.distance : null,
    };
    return { apexes: list.concat([apex]), added: true, reason: '' };
  }

  function undo(apexes) {
    return Array.isArray(apexes) && apexes.length ? apexes.slice(0, -1) : [];
  }

  /** Apexes ordered along the line (by arc length), unassociated ones last, in tap order. */
  function ordered(apexes) {
    return (apexes || []).map((a, i) => ({ a, i }))
      .sort((p, q) => {
        const ps = p.a.s_m == null ? Infinity : p.a.s_m;
        const qs = q.a.s_m == null ? Infinity : q.a.s_m;
        return ps - qs || p.i - q.i;
      })
      .map((p) => p.a);
  }

  /** The saved file: map-frame apexes plus the identity of the line they belong to. */
  function exportDocument(apexes, line, meta) {
    return {
      format: FORMAT,
      version: VERSION,
      frame: 'map',
      created: (meta && meta.created) || null,
      car: (meta && meta.car) || null,
      line: lineFingerprint(line),
      note: 'Offline racing-line edit request. Not a command: nothing here is sent to the car.',
      apexes: ordered(apexes).map((a) => ({
        x: a.x, y: a.y, waypoint_index: a.waypoint_index, s_m: a.s_m,
        distance_to_line_m: a.distance_to_line_m,
      })),
    };
  }

  const api = {
    FORMAT, VERSION, MIN_SEPARATION_M,
    isMapPoint, nearestWaypoint, lineFingerprint, addApex, undo, ordered, exportDocument,
  };
  if (typeof window !== 'undefined') window.__apex = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
