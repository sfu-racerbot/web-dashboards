// The pretend world the mock car drives around: an oval track on an
// occupancy grid, a car going round it, a LiDAR, and a "SLAM" that reveals
// the map as the car goes. Pure computation -- no sockets, no timers -- so
// server.mjs decides when things happen and test/ can drive it directly.

import zlib from 'node:zlib';

// Grid: 24 m x 16 m at 5 cm, origin at the bottom-left, centred on (0, 0).
export const GRID = { width: 480, height: 320, resolution: 0.05, originX: -12, originY: -8 };

const TRACK = { a: 8, b: 4.5, halfWidth: 1.1, wall: 0.15 };
const LASER = { offsetX: 0.26, offsetY: 0, angleMin: -2.35619, angleIncrement: 0.0043633, count: 1081, rangeMin: 0.02, rangeMax: 10 };

/** Approximate distance from (x, y) to the centreline ellipse. */
function distanceToCentreline(x, y) {
  const { a, b } = TRACK;
  // Scale to the unit circle, find the angle, then measure to that point.
  const t = Math.atan2(y / b, x / a);
  const px = a * Math.cos(t);
  const py = b * Math.sin(t);
  return Math.hypot(x - px, y - py);
}

function cellCentre(i, j) {
  return [GRID.originX + (i + 0.5) * GRID.resolution, GRID.originY + (j + 0.5) * GRID.resolution];
}

/** The true map: 100 wall, 0 track surface, -1 outside anything the LiDAR sees. */
export function buildTruth() {
  const cells = new Int8Array(GRID.width * GRID.height);
  for (let j = 0; j < GRID.height; j++) {
    for (let i = 0; i < GRID.width; i++) {
      const [x, y] = cellCentre(i, j);
      const d = distanceToCentreline(x, y);
      let value = -1;
      if (d <= TRACK.halfWidth) value = 0;
      else if (d <= TRACK.halfWidth + TRACK.wall) value = 100;
      cells[j * GRID.width + i] = value;
    }
  }
  return cells;
}

/** Where the car is at parameter t along the lap, with its heading and curvature. */
export function poseAt(t) {
  const { a, b } = TRACK;
  const x = a * Math.cos(t);
  const y = b * Math.sin(t);
  const dx = -a * Math.sin(t);
  const dy = b * Math.cos(t);
  const ddx = -a * Math.cos(t);
  const ddy = -b * Math.sin(t);
  const speedScale = Math.hypot(dx, dy);
  const curvature = (dx * ddy - dy * ddx) / speedScale ** 3;
  return { x, y, yaw: Math.atan2(dy, dx), curvature, dsdt: speedScale };
}

/** The driving model: slower where the track bends harder. */
export function targetSpeed(curvature) {
  return Math.max(1.0, Math.min(3.0, 3.2 - 5 * Math.abs(curvature)));
}

/** One LiDAR sweep from a pose, ray-marched against the true walls, as metres. */
export function scan(truth, pose) {
  const out = new Float32Array(LASER.count);
  const lx = pose.x + LASER.offsetX * Math.cos(pose.yaw);
  const ly = pose.y + LASER.offsetX * Math.sin(pose.yaw);
  const step = GRID.resolution / 2;
  for (let k = 0; k < LASER.count; k++) {
    const angle = pose.yaw + LASER.angleMin + k * LASER.angleIncrement;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    let range = Infinity;
    for (let r = step; r <= LASER.rangeMax; r += step) {
      const i = Math.floor((lx + r * cos - GRID.originX) / GRID.resolution);
      const j = Math.floor((ly + r * sin - GRID.originY) / GRID.resolution);
      if (i < 0 || j < 0 || i >= GRID.width || j >= GRID.height) break;
      if (truth[j * GRID.width + i] === 100) { range = r; break; }
    }
    out[k] = range;
  }
  return out;
}

/** The scan header and u16 millimetre payload, as protocol.py builds them. */
export function scanFrame(ranges) {
  const payload = Buffer.alloc(ranges.length * 2);
  for (let k = 0; k < ranges.length; k++) {
    const v = ranges[k];
    const mm = Number.isFinite(v) && v > 0 && v <= 65.535 ? Math.round(v * 1000) : 0;
    payload.writeUInt16LE(mm, k * 2);
  }
  const header = {
    type: 'scan', bytes: payload.length, encoding: 'u16mm',
    angle_min: LASER.angleMin, angle_increment: LASER.angleIncrement,
    range_min: LASER.rangeMin, range_max: LASER.rangeMax, count: ranges.length,
    laser_offset_x: LASER.offsetX, laser_offset_y: LASER.offsetY, stamp: Date.now() / 1000,
  };
  return { header, payload };
}

/**
 * Keyframes and patches with sequence numbers, exactly as the car's
 * mapstream.py produces them: a keyframe bumps seq; a patch bumps seq and
 * carries only the changed rectangle; a new connection gets the current
 * grid under the CURRENT seq, so the next patch follows on for it too.
 */
export class MapStream {
  constructor() {
    this.seq = 0;
    this.cells = null;
  }

  encode(raw) {
    return zlib.deflateSync(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength), { level: 1 });
  }

  keyframeFrame(seq) {
    const payload = this.encode(this.cells);
    return {
      header: {
        type: 'map', seq, width: GRID.width, height: GRID.height, resolution: GRID.resolution,
        origin_x: GRID.originX, origin_y: GRID.originY, origin_yaw: 0, encoding: 'deflate',
        bytes: payload.length, raw_bytes: this.cells.length, stamp: Date.now() / 1000,
      },
      payload,
    };
  }

  /** A fresh keyframe for everyone. */
  keyframe(cells) {
    this.cells = Int8Array.from(cells);
    this.seq += 1;
    return this.keyframeFrame(this.seq);
  }

  /** The grid as it stands, for one newly connected client. */
  current() {
    return this.cells ? this.keyframeFrame(this.seq) : null;
  }

  /** A patch from the last grid to this one, or null if nothing changed. */
  update(cells) {
    if (!this.cells) return this.keyframe(cells);
    let x0 = Infinity; let y0 = Infinity; let x1 = -1; let y1 = -1;
    for (let j = 0; j < GRID.height; j++) {
      for (let i = 0; i < GRID.width; i++) {
        const k = j * GRID.width + i;
        if (cells[k] !== this.cells[k]) {
          if (i < x0) x0 = i; if (i > x1) x1 = i;
          if (j < y0) y0 = j; if (j > y1) y1 = j;
        }
      }
    }
    if (x1 < 0) return null;
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    const raw = new Int8Array(w * h);
    for (let row = 0; row < h; row++) {
      raw.set(cells.subarray((y0 + row) * GRID.width + x0, (y0 + row) * GRID.width + x0 + w), row * w);
    }
    this.cells = Int8Array.from(cells);
    this.seq += 1;
    const payload = this.encode(raw);
    return {
      header: {
        type: 'map_patch', seq: this.seq, x: x0, y: y0, w, h, encoding: 'deflate',
        bytes: payload.length, raw_bytes: raw.length, stamp: Date.now() / 1000,
      },
      payload,
    };
  }
}

/** What "SLAM" has seen so far: the truth, revealed within a radius of each pose. */
export class Reveal {
  constructor(truth) {
    this.truth = truth;
    this.cells = new Int8Array(truth.length).fill(-1);
  }

  around(pose, radius = 3.5) {
    const r = Math.ceil(radius / GRID.resolution);
    const ci = Math.floor((pose.x - GRID.originX) / GRID.resolution);
    const cj = Math.floor((pose.y - GRID.originY) / GRID.resolution);
    for (let j = Math.max(0, cj - r); j <= Math.min(GRID.height - 1, cj + r); j++) {
      for (let i = Math.max(0, ci - r); i <= Math.min(GRID.width - 1, ci + r); i++) {
        if ((i - ci) ** 2 + (j - cj) ** 2 <= r * r) this.cells[j * GRID.width + i] = this.truth[j * GRID.width + i];
      }
    }
  }

  /** A small box that appears and disappears, so there is always a patch to send. */
  blink(on) {
    const i0 = Math.floor((0 - GRID.originX) / GRID.resolution);
    const j0 = Math.floor((4.5 - GRID.originY) / GRID.resolution);
    for (let j = j0 - 2; j <= j0 + 2; j++) {
      for (let i = i0 - 2; i <= i0 + 2; i++) this.cells[j * GRID.width + i] = on ? 100 : this.truth[j * GRID.width + i];
    }
  }
}

/** A /drive_intent payload in the shape drive_intent/schema.py builds. */
export function intentPayload({ t, dtdS, state, severity, speed, reason }) {
  const path = [];
  const horizon = 1.5;
  const here = poseAt(t);
  const cos = Math.cos(-here.yaw);
  const sin = Math.sin(-here.yaw);
  for (let k = 0; k <= 12; k++) {
    const s = (speed * horizon * k) / 12;
    const p = poseAt(t + s * dtdS);
    const dx = p.x - here.x;
    const dy = p.y - here.y;
    path.push({ x: +(dx * cos - dy * sin).toFixed(3), y: +(dx * sin + dy * cos).toFixed(3), v: +speed.toFixed(2) });
  }
  const curvCap = targetSpeed(here.curvature);
  const factors = [
    { name: 'max_speed', value: 3.0, unit: 'm/s', binding: false },
    { name: 'curvature', value: +curvCap.toFixed(3), unit: 'm/s', binding: false },
  ];
  const lowest = Math.min(...factors.map((f) => f.value));
  factors.forEach((f) => { f.binding = f.value === lowest; });
  const steering = Math.atan(0.36 * here.curvature);
  return {
    v: 1, stamp: Date.now() / 1000, node: 'pure_pursuit_node', frame: 'base_link', state, severity,
    horizon_s: horizon, desired_steering: +steering.toFixed(4), commanded_steering: +steering.toFixed(4),
    desired_speed: +speed.toFixed(3), commanded_speed: +speed.toFixed(3),
    path, commanded_path: [], factors, targets: [{ kind: 'steering target', x: path[8].x, y: path[8].y }],
    reason,
  };
}
