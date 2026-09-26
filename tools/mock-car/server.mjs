#!/usr/bin/env node
// A stand-in for the car, for developing the dashboards with no car.
//
//   node tools/mock-car/server.mjs [--port 8080] [--camera-port 9090]
//        [--protocol 1] [--no-hello] [--keyframe-sec 30]
//
// It serves what the three tunnel hostnames reach on a real car:
//   ws://localhost:8080/ws?role=relay|control   dashboard_node
//   http://localhost:9090/stream                usb_cam_stream (MJPEG)
// and prints messages per second, per role, every 5 seconds.
//
// See tools/mock-car/README.md for how to run it with `wrangler dev`.

import http from 'node:http';
import { parseArgs } from 'node:util';
import { WebSocketServer } from 'ws';
import { MockCar } from './car.mjs';
import { MjpegSource } from './mjpeg.mjs';

const { values: args } = parseArgs({
  options: {
    port: { type: 'string', default: '8080' },
    'camera-port': { type: 'string', default: '9090' },
    protocol: { type: 'string', default: '1' },
    'no-hello': { type: 'boolean', default: false },
    'keyframe-sec': { type: 'string', default: '30' },
    'allow-origin': { type: 'string', multiple: true, default: ['https://dashboard.sfuracerbot.ca', 'http://localhost:8787', 'http://127.0.0.1:8787'] },
    quiet: { type: 'boolean', default: false },
  },
});

const car = new MockCar({
  protocolVersion: Number(args.protocol),
  sendHello: !args['no-hello'],
  keyframeSec: Number(args['keyframe-sec']),
});

const connections = new Set();
const counts = { relay: newCount(), control: newCount() };
function newCount() { return { text: 0, binary: 0, bytes: 0, received: 0 }; }

function send(conn, frame) {
  if (conn.ws.readyState !== 1) return;
  const text = JSON.stringify(frame.header);
  conn.ws.send(text);
  const c = counts[conn.role];
  c.text++; c.bytes += text.length;
  if (frame.payload) {
    conn.ws.send(frame.payload, { binary: true });
    c.binary++; c.bytes += frame.payload.length;
  }
}

/** Telemetry goes to relay connections only; control connections get state and replies. */
function toRelays(frame) {
  for (const conn of connections) if (conn.role === 'relay') send(conn, frame);
}
function toControls(frame) {
  for (const conn of connections) if (conn.role === 'control') send(conn, frame);
}
function toAll(frame) {
  for (const conn of connections) {
    if (frame.relayOnly && conn.role !== 'relay') continue;
    send(conn, frame);
  }
}

// -- the dashboard_node WebSocket ------------------------------------------------

const wss = new WebSocketServer({ noServer: true });
const dashServer = http.createServer((req, res) => {
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('mock car: only the /ws WebSocket lives here\n');
});

dashServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://mock');
  if (url.pathname !== '/ws') {
    socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
    return;
  }
  const origin = req.headers.origin;
  if (origin && !args['allow-origin'].includes(origin)) {
    log(`refused a connection from origin ${origin}`);
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  // The header is what the Worker sets and a browser cannot; the query
  // string is the fallback for pointing a page straight at the mock.
  const role = (req.headers['x-racerbot-role'] || url.searchParams.get('role') || 'relay').toLowerCase();
  if (role !== 'relay' && role !== 'control') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  const user = req.headers['x-racerbot-user'] || '(none)';
  const token = req.headers['cf-access-client-id'] ? 'service token present' : 'no service token';
  wss.handleUpgrade(req, socket, head, (ws) => {
    const conn = { ws, role, user, armed: false };
    connections.add(conn);
    log(`+ ${role} connection (user ${user}, ${token}, origin ${origin || '(none)'}); ${describeConnections()}`);
    for (const frame of car.initialFrames(role)) send(conn, frame);
    ws.on('message', (data, isBinary) => {
      counts[role].received++;
      if (isBinary) return;
      let message;
      try { message = JSON.parse(String(data)); } catch { return; }
      const { reply, broadcast, refused } = car.handle(conn, message);
      if (refused) log(`refused ${message.type}/${message.action} on a ${role} connection`);
      else if (message.type) log(`${user}: ${message.type}/${message.action}${message.name ? ` ${message.name}=${message.value}` : ''}`);
      for (const frame of reply) send(conn, frame);
      for (const frame of broadcast) toAll(frame);
    });
    ws.on('close', (code) => {
      connections.delete(conn);
      log(`- ${role} connection closed (${code}); ${describeConnections()}`);
    });
  });
});

function describeConnections() {
  const n = (role) => [...connections].filter((c) => c.role === role).length;
  return `${n('relay')} relay, ${n('control')} control`;
}

// -- the timers dashboard_node runs ----------------------------------------------

setInterval(() => toRelays(car.tickBatch()), 50);          // telemetry_rate_hz 20
setInterval(() => toRelays(car.tickScan()), 100);          // scan_broadcast_rate_hz 10
setInterval(() => {                                        // map updates, keyframe every keyframe_sec
  const frame = car.tickMap();
  if (frame) toRelays(frame);
}, 1000);
setInterval(() => car.tickStats(), 1000);                   // stats_interval_sec 1, rides in the next batch
setInterval(() => toControls(car.tickStopwatch()), 250);   // stopwatch_update_rate_hz 4, ditto

// -- the camera ------------------------------------------------------------------

const camera = new MjpegSource();
const cameraServer = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://mock');
  if (url.pathname !== '/stream') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('mock camera: GET /stream\n');
    return;
  }
  const tier = url.searchParams.get('tier') === 'full' ? 'full' : 'preview';
  log(`+ camera stream (${tier}) for ${req.headers['x-racerbot-user'] || '(no user header)'}`);
  camera.serve(req, res, tier);
});

// -- rates -----------------------------------------------------------------------

const RATE_EVERY_S = 5;
let lastRates = Date.now();
setInterval(() => {
  const secs = (Date.now() - lastRates) / 1000;
  lastRates = Date.now();
  const line = ['relay', 'control'].map((role) => {
    const c = counts[role];
    const conns = [...connections].filter((x) => x.role === role).length;
    const per = conns || 1;
    const msgs = (c.text + c.binary) / secs / per;
    const out = `${role}: ${conns} conn, ${msgs.toFixed(1)} msg/s per conn `
      + `(${(c.text / secs / per).toFixed(1)} text + ${(c.binary / secs / per).toFixed(1)} binary), `
      + `${(c.bytes / secs / per / 1024).toFixed(1)} kB/s per conn, ${(c.received / secs).toFixed(2)} msg/s in`;
    counts[role] = newCount();
    return out;
  });
  line.push(`camera: ${camera.clients} stream(s), ${camera.fps.toFixed(1)} fps`);
  if (!args.quiet) console.log(`[rates] ${line.join(' | ')}`);
}, RATE_EVERY_S * 1000);

function log(message) {
  if (!args.quiet) console.log(`[mock-car] ${message}`);
}

dashServer.listen(Number(args.port), () => {
  cameraServer.listen(Number(args['camera-port']), () => {
    console.log(`[mock-car] dashboard_node on ws://localhost:${args.port}/ws?role=relay|control, `
      + `camera on http://localhost:${args['camera-port']}/stream, protocol ${args['no-hello'] ? 'none (no hello)' : args.protocol}`);
  });
});
