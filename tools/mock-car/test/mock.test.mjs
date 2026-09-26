// The mock car has to behave like the car contract says, or `wrangler dev`
// plus the mock proves nothing. These run the real server on spare ports.
//
//   node --test tools/mock-car/test/*.test.mjs

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import WebSocket from 'ws';
import { GRID, MapStream, Reveal, buildTruth, poseAt } from '../world.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, '..', 'server.mjs');

function startMock(port, cameraPort, extra = []) {
  const child = spawn(process.execPath, [SERVER, '--port', String(port), '--camera-port', String(cameraPort), '--quiet', ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { if (String(d).includes('dashboard_node on')) resolve(child); });
    child.on('exit', (code) => reject(new Error(`mock exited ${code}`)));
  });
}

/** Connect and collect every message for `ms`, as {text, binary} in order. */
function collect(url, ms, { headers = {}, onOpen } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const got = [];
    ws.on('message', (data, isBinary) => got.push(isBinary ? { binary: data } : { json: JSON.parse(String(data)) }));
    ws.on('open', () => onOpen && onOpen(ws, got));
    ws.on('error', reject);
    setTimeout(() => { ws.close(); resolve(got); }, ms);
  });
}

const PORT = 18181;
const CAM = 19191;
let mock;

describe('the mock car', () => {
  before(async () => { mock = await startMock(PORT, CAM, ['--keyframe-sec', '2']); });
  after(() => mock.kill());

  it('relay: hello first, then the whole stream, header+binary pairs intact', async () => {
    const got = await collect(`ws://localhost:${PORT}/ws?role=relay`, 2500);
    assert.deepEqual(got[0].json, { type: 'hello', protocol_version: 1 });
    const types = new Set(got.filter((m) => m.json).map((m) => m.json.type));
    for (const t of ['map', 'scan', 'batch', 'tuning', 'processes', 'saved_maps']) assert.ok(types.has(t), t);
    for (let i = 0; i < got.length; i++) {
      const m = got[i];
      if (m.json && typeof m.json.bytes === 'number') {
        assert.ok(got[i + 1] && got[i + 1].binary, `${m.json.type} is followed by a binary`);
        assert.equal(got[i + 1].binary.length, m.json.bytes, `${m.json.type} binary length`);
      }
    }
    const batchTypes = new Set(got.filter((m) => m.json && m.json.type === 'batch').flatMap((m) => m.json.items.map((x) => x.type)));
    for (const t of ['pose', 'drive', 'speed', 'intent', 'stats', 'stopwatch']) assert.ok(batchTypes.has(t), `batch carries ${t}`);
  });

  it('relay: map seq runs keyframe, patch, patch... and a keyframe every keyframe_sec', async () => {
    const got = await collect(`ws://localhost:${PORT}/ws?role=relay`, 4500);
    const maps = got.filter((m) => m.json && (m.json.type === 'map' || m.json.type === 'map_patch')).map((m) => m.json);
    assert.equal(maps[0].type, 'map');
    for (let i = 1; i < maps.length; i++) {
      if (maps[i].type === 'map_patch') assert.equal(maps[i].seq, maps[i - 1].seq + 1, 'patch follows the frame before it');
      else assert.ok(maps[i].seq > maps[i - 1].seq, 'keyframe moves seq on');
    }
    assert.ok(maps.filter((m) => m.type === 'map').length >= 2, 'at least one periodic keyframe');
  });

  it('relay: refuses every write', async () => {
    const got = await collect(`ws://localhost:${PORT}/ws?role=relay`, 800, {
      onOpen: (ws) => {
        ws.send(JSON.stringify({ type: 'tuning_control', action: 'arm', armed: true }));
        ws.send(JSON.stringify({ type: 'process_control', action: 'stop', pid: 4242 }));
      },
    });
    const results = got.filter((m) => m.json && (m.json.type === 'tuning_result' || m.json.type === 'process_result')).map((m) => m.json);
    assert.equal(results.length, 2);
    for (const r of results) assert.equal(r.ok, false);
    assert.ok(!got.some((m) => m.json && m.json.type === 'tuning_armed' && m.json.armed === true));
  });

  it('control: hello and panel state only -- no map, scan or batch', async () => {
    const got = await collect(`ws://localhost:${PORT}/ws`, 1500, { headers: { 'X-Racerbot-Role': 'control' } });
    assert.deepEqual(got[0].json, { type: 'hello', protocol_version: 1 });
    const types = new Set(got.filter((m) => m.json).map((m) => m.json.type));
    for (const t of ['tuning', 'processes', 'saved_maps', 'stopwatch']) assert.ok(types.has(t), t);
    for (const t of ['map', 'map_patch', 'scan', 'batch']) assert.ok(!types.has(t), `no ${t}`);
    assert.ok(!got.some((m) => m.binary), 'no binary frames at all');
  });

  it('control: writes need arming, and arming is per connection', async () => {
    let other;
    const got = await collect(`ws://localhost:${PORT}/ws?role=control`, 1200, {
      onOpen: (ws) => {
        ws.send(JSON.stringify({ type: 'tuning_control', action: 'set', node: 'gap_follow_node', name: 'max_speed', value: 1.2 }));
        ws.send(JSON.stringify({ type: 'tuning_control', action: 'arm', armed: true }));
        ws.send(JSON.stringify({ type: 'tuning_control', action: 'set', node: 'gap_follow_node', name: 'max_speed', value: 1.2 }));
        other = collect(`ws://localhost:${PORT}/ws?role=control`, 600, {
          onOpen: (ws2) => ws2.send(JSON.stringify({ type: 'tuning_control', action: 'set', node: 'gap_follow_node', name: 'max_speed', value: 0.7 })),
        });
      },
    });
    const results = got.filter((m) => m.json && m.json.type === 'tuning_result').map((m) => m.json);
    assert.equal(results[0].ok, false, 'refused before arming');
    assert.ok(results.some((r) => r.ok && r.value === 1.2), 'accepted once armed');
    const otherResults = (await other).filter((m) => m.json && m.json.type === 'tuning_result' && m.json.value !== 1.2).map((m) => m.json);
    assert.ok(otherResults.some((r) => r.ok === false && /not armed/.test(r.reason)), 'another connection is not armed');
  });

  it('camera: a never-ending multipart/x-mixed-replace stream of JPEGs', async () => {
    const { contentType, boundaries } = await new Promise((resolve, reject) => {
      const req = http.get(`http://localhost:${CAM}/stream?tier=preview`, (res) => {
        let seen = 0;
        res.on('data', (chunk) => { seen += String(chunk.toString('latin1')).split('--mockcarframe').length - 1; });
        setTimeout(() => { req.destroy(); resolve({ contentType: res.headers['content-type'], boundaries: seen }); }, 700);
      });
      req.on('error', (err) => { if (err.code !== 'ECONNRESET') reject(err); });
    });
    assert.match(contentType, /^multipart\/x-mixed-replace; boundary=mockcarframe$/);
    assert.ok(boundaries >= 4, `got ${boundaries} frames in 0.7 s`);
  });
});

describe('the mock car without a hello', () => {
  let old;
  before(async () => { old = await startMock(PORT + 1, CAM + 1, ['--no-hello']); });
  after(() => old.kill());

  it('opens with telemetry, like a pre-migration car', async () => {
    const got = await collect(`ws://localhost:${PORT + 1}/ws?role=relay`, 500);
    assert.notEqual(got[0].json.type, 'hello');
  });
});

describe('world.mjs map stream', () => {
  it('keyframe + patch reproduce the grid, after inflating', () => {
    const truth = buildTruth();
    const reveal = new Reveal(truth);
    const stream = new MapStream();
    reveal.around(poseAt(0));
    const key = stream.keyframe(reveal.cells);
    reveal.around(poseAt(0.6));
    const patch = stream.update(reveal.cells);
    assert.equal(patch.header.seq, key.header.seq + 1);
    const grid = new Int8Array(zlib.inflateSync(key.payload).buffer.slice(0));
    const cells = new Int8Array(zlib.inflateSync(patch.payload));
    const { x, y, w, h } = patch.header;
    for (let row = 0; row < h; row++) grid.set(cells.subarray(row * w, row * w + w), (y + row) * GRID.width + x);
    assert.deepEqual(grid, reveal.cells);
    assert.equal(stream.current().header.seq, patch.header.seq, 'a new client gets the current seq');
  });

  it('says nothing when nothing changed', () => {
    const stream = new MapStream();
    const cells = new Int8Array(GRID.width * GRID.height);
    stream.keyframe(cells);
    assert.equal(stream.update(cells), null);
  });
});
