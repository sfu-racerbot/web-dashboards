/*
 * The two sockets: telemetry from the shared relay, writes over this tab's
 * own control link.
 *
 * Once the dashboard moved off the car and behind a relay that everyone
 * watching shares, "which socket does this message go down" became a
 * safety question. Telemetry is fanned out to every viewer and the relay
 * refuses writes; arming is per connection on the car. So a write that
 * leaked onto the telemetry socket would simply fail -- and a control link
 * that never closed would keep a tuning panel armed long after the person
 * who armed it put their phone away.
 *
 * This loads the real web/dashboard.js into a stubbed DOM with fake
 * WebSockets and a fake clock, and checks:
 *   - every URL comes from the page's own origin and the car in its path,
 *     and only http://localhost may override them;
 *   - every write goes over /<car>/control, opened lazily, and nothing but
 *     "clear view" and the heartbeat ever goes down the telemetry socket;
 *   - the control link closes after CONTROL_IDLE_MIN of no writes, and when
 *     the tab is hidden, and closing it disarms the tuning panel;
 *   - arm state is only ever taken from the control link;
 *   - the protocol check and the relay's status reach the link-state row.
 *
 * Run directly with `node control_link_test.js`, or via test/run_all.js.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DASHBOARD_JS = path.join(__dirname, '..', '..', 'web', 'dashboard.js');
const CAMERA_JS = path.join(__dirname, '..', '..', 'web', 'camera.js');

// --- a fake clock ------------------------------------------------------------

function makeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, at: now + (ms || 0), every: 0 });
      return id;
    },
    setInterval(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, at: now + ms, every: ms });
      return id;
    },
    clear(id) { timers.delete(id); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let due = null;
        for (const [id, t] of timers) if (t.at <= end && (!due || t.at < due[1].at)) due = [id, t];
        if (!due) break;
        const [id, t] = due;
        now = t.at;
        if (t.every) t.at += t.every; else timers.delete(id);
        t.fn();
      }
      now = end;
    },
  };
}

// --- a DOM stub that remembers elements by id ----------------------------------

function stubElement() {
  const el = {
    style: {}, dataset: {}, children: [], textContent: '', innerHTML: '', title: '',
    className: '', checked: false, value: '', disabled: false, hidden: false,
    width: 800, height: 600,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, removeEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
    setAttribute() {}, removeAttribute() {}, getAttribute() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { width: 100, height: 100, top: 0, left: 0, right: 100, bottom: 100 }; },
    focus() {}, blur() {},
    setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture() { return false; },
  };
  el.getContext = () => new Proxy({
    canvas: el,
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData() {}, measureText: () => ({ width: 0 }), save() {}, restore() {},
  }, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
  return el;
}

function loadDashboard(location) {
  const clock = makeClock();
  const sockets = [];
  const warnings = [];
  const docListeners = {};
  const elements = new Map();

  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      this.closed = null;
      sockets.push(this);
    }
    send(data) { this.sent.push(data); }
    close(code, reason) {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.closed = { code, reason };
      if (this.onclose) this.onclose({ code, reason });
    }
    // test helpers
    open() { this.readyState = 1; if (this.onopen) this.onopen(); }
    receive(data) { this.onmessage({ data: typeof data === 'string' ? data : data }); }
    receiveJson(obj) { this.onmessage({ data: JSON.stringify(obj) }); }
  }
  FakeWebSocket.OPEN = 1;

  const document = {
    visibilityState: 'visible',
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, stubElement());
      return elements.get(id);
    },
    createElement: () => stubElement(),
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
    activeElement: null, body: stubElement(),
  };
  const sandbox = {
    document,
    WebSocket: FakeWebSocket,
    location,
    URLSearchParams,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    performance: { now: () => Date.now() },
    requestAnimationFrame: () => 0,
    setTimeout: clock.setTimeout, clearTimeout: clock.clear,
    setInterval: clock.setInterval, clearInterval: clock.clear,
    addEventListener() {}, removeEventListener() {},
    innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
    getComputedStyle() { return { right: '12px', bottom: '47px' }; },
    confirm: () => true,
    console: { log() {}, warn: (...a) => warnings.push(a.join(' ')), error: (...a) => warnings.push(a.join(' ')) },
    Date, Math, JSON, Promise,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(DASHBOARD_JS, 'utf8'), sandbox, { filename: 'dashboard.js' });
  return {
    sandbox, clock, sockets, warnings, el: (id) => document.getElementById(id),
    hide() { document.visibilityState = 'hidden'; (docListeners.visibilitychange || []).forEach((fn) => fn()); },
  };
}

// --- checks ----------------------------------------------------------------

let checks = 0;
let failures = 0;
function check(name, condition, detail) {
  checks++;
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail !== undefined ? `\n        ${detail}` : ''}`);
  }
}
function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const SITE = { protocol: 'https:', host: 'dashboard.sfuracerbot.ca', hostname: 'dashboard.sfuracerbot.ca',
  pathname: '/rb2/simple/', search: '' };

// ---------------------------------------------------------------------------
console.log('endpoints come from the page, never from anything it is told');
{
  const { sandbox } = loadDashboard(SITE);
  const resolve = sandbox.window.__resolveEndpoints;
  const site = resolve(SITE);
  eq('telemetry is the relay for the car in the path', site.telemetry, 'wss://dashboard.sfuracerbot.ca/rb2/ws');
  eq('control is this tab\'s own link for that car', site.control, 'wss://dashboard.sfuracerbot.ca/rb2/control');
  eq('the camera is same-origin, under the car', site.camera, '/rb2/camera');
  eq('camera.html (a file in the same folder) resolves the same car',
    resolve(Object.assign({}, SITE, { pathname: '/rb2/simple/camera.html' })).telemetry,
    'wss://dashboard.sfuracerbot.ca/rb2/ws');

  const hostile = resolve(Object.assign({}, SITE, { search: '?ws=wss://evil.example/ws&camera=https://evil.example' }));
  eq('?ws= is ignored on the real site', hostile.telemetry, 'wss://dashboard.sfuracerbot.ca/rb2/ws');
  eq('?camera= is ignored on the real site', hostile.camera, '/rb2/camera');

  const local = { protocol: 'http:', host: 'localhost:8787', hostname: 'localhost', pathname: '/rb2/simple/', search: '' };
  eq('wrangler dev: plain ws on the same origin', resolve(local).telemetry, 'ws://localhost:8787/rb2/ws');
  const mock = resolve(Object.assign({}, local, {
    search: '?ws=ws://localhost:8090/ws?role=relay&control=ws://localhost:8090/ws?role=control&camera=http://localhost:8090/',
  }));
  eq('localhost may override telemetry', mock.telemetry, 'ws://localhost:8090/ws?role=relay');
  eq('localhost may override control', mock.control, 'ws://localhost:8090/ws?role=control');
  eq('localhost may override the camera (trailing slash dropped)', mock.camera, 'http://localhost:8090');
  eq('https on localhost is not treated as local dev',
    resolve(Object.assign({}, SITE, { host: 'localhost', hostname: 'localhost', search: '?ws=ws://x/ws' })).telemetry,
    'wss://localhost/rb2/ws');
  eq('a path segment that is not a car id is not used as one',
    resolve(Object.assign({}, SITE, { pathname: '/%2e%2e/simple/' })).telemetry, 'wss://dashboard.sfuracerbot.ca/ws');
  eq('a stub location with no pathname still resolves (the older tests use one)',
    resolve({ host: 'car:8080', hostname: 'car' }).telemetry, 'ws://car:8080/ws');
}

// ---------------------------------------------------------------------------
console.log('\ncamera.js resolves the same way');
{
  const sandbox = {
    document: { getElementById: () => stubElement(), addEventListener() {} },
    WebSocket: class { constructor(url) { this.url = url; } send() {} close() {} },
    location: SITE, URLSearchParams,
    performance: { now: () => 0 }, setTimeout: () => 0, setInterval: () => 0,
    clearInterval() {}, clearTimeout() {},
    Date, console,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(CAMERA_JS, 'utf8'), sandbox, { filename: 'camera.js' });
  const resolve = sandbox.window.__cameraEndpoints;
  eq('telemetry', resolve(Object.assign({}, SITE, { pathname: '/rb2/simple/camera.html' })).telemetry,
    'wss://dashboard.sfuracerbot.ca/rb2/ws');
  eq('camera', resolve(Object.assign({}, SITE, { pathname: '/rb2/simple/camera.html' })).camera, '/rb2/camera');
  eq('overrides ignored off localhost',
    resolve(Object.assign({}, SITE, { search: '?camera=https://evil.example' })).camera, '/rb2/camera');
}

// ---------------------------------------------------------------------------
console.log('\nthe protocol check');
{
  const { sandbox } = loadDashboard(SITE);
  const verdict = sandbox.window.__protocolVerdict;
  check('the supported version is fine', verdict(1, 1).ok);
  check('version 0 (no hello at all: a pre-migration car) keeps working', verdict(0, 1).ok);
  check('not known yet is not a mismatch', verdict(null, 1).ok && verdict(null, 1).pending);
  const bad = verdict(2, 1);
  check('any other version is a mismatch', !bad.ok);
  eq('and says what to do about it', bad.message,
    'this car runs protocol 2, this site expects 1: update the car or redeploy the site');
}

// ---------------------------------------------------------------------------
console.log('\ntelemetry at load, and nothing else');
{
  const t = loadDashboard(SITE);
  eq('exactly one socket at load', t.sockets.length, 1);
  eq('and it is the relay', t.sockets[0].url, 'wss://dashboard.sfuracerbot.ca/rb2/ws');
  const telemetry = t.sockets[0];
  telemetry.open();
  t.clock.advance(10000);
  eq('it sends the relay a heartbeat', telemetry.sent[0], '{"type":"relay_ping"}');
}

// ---------------------------------------------------------------------------
console.log('\nevery write goes over the control link');
{
  const t = loadDashboard(SITE);
  const telemetry = t.sockets[0];
  telemetry.open();
  const writes = t.sandbox.window.__writeActions;

  writes.sendStopwatchControl('reset');
  eq('the first write opens a second socket', t.sockets.length, 2);
  const control = t.sockets[1];
  eq('and it is the control link', control.url, 'wss://dashboard.sfuracerbot.ca/rb2/control');
  eq('the write waits for it to open', control.sent.length, 0);
  control.open();
  eq('then goes out on it', JSON.parse(control.sent[0]).type, 'stopwatch_control');

  writes.sendTuningControl({ action: 'arm', armed: true });
  writes.sendTuningControl({ action: 'set', node: 'gap_follow_node', name: 'max_speed', value: 1.0 });
  writes.sendTuningControl({ action: 'save' });
  writes.sendProcessControl({ action: 'stop', pid: 42 });
  writes.sendMapControl({ action: 'delete', id: 'run', confirm: 'run', digest: 'd' });
  writes.sendMapControl({ action: 'reset_slam' });
  writes.sendStopwatchControl('set_enabled', true);
  const kinds = control.sent.map((s) => { const m = JSON.parse(s); return `${m.type}:${m.action}`; });
  eq('arm, set, save, stop, delete, reset SLAM and the stopwatch all used it',
    kinds.join(','),
    'stopwatch_control:reset,tuning_control:arm,tuning_control:set,tuning_control:save,'
    + 'process_control:stop,map_control:delete,map_control:reset_slam,stopwatch_control:set_enabled');
  eq('still only one control link', t.sockets.length, 2);

  writes.sendMapControl({ action: 'clear_view' });
  const telemetryWrites = telemetry.sent.filter((s) => s !== '{"type":"relay_ping"}').map((s) => JSON.parse(s));
  eq('clear view (browser-only, not a write) goes to the relay', telemetryWrites.length, 1);
  eq('and is the only thing that ever did', telemetryWrites[0] && telemetryWrites[0].action, 'clear_view');
}

// ---------------------------------------------------------------------------
console.log('\narming never outlives attention');
{
  const t = loadDashboard(SITE);
  t.sockets[0].open();
  const writes = t.sandbox.window.__writeActions;
  writes.sendTuningControl({ action: 'arm', armed: true });
  const control = t.sockets[1];
  control.open();
  control.receiveJson({ type: 'tuning_armed', armed: true });
  eq('an arm confirmed on the control link arms the panel', t.el('tuning-arm').checked, true);
  eq('the link-state row says a control link is open', t.el('control-text').textContent, 'ctl open');

  t.sockets[0].receiveJson({ type: 'tuning_armed', armed: false });
  eq('an arm message on the shared telemetry stream is ignored', t.el('tuning-arm').checked, true);

  t.clock.advance(4 * 60 * 1000);
  eq('four idle minutes: still open', control.closed, null);
  writes.sendTuningControl({ action: 'set', node: 'n', name: 'p', value: 1 });
  t.clock.advance(4 * 60 * 1000);
  eq('a write restarts the idle clock', control.closed, null);
  control.receiveJson({ type: 'tuning', enabled: true, allow_save: true, nodes: [] });
  t.clock.advance(1 * 60 * 1000 + 1);
  check('five minutes after the last write it closes, however chatty the car was',
    control.closed && control.closed.reason === 'idle', JSON.stringify(control.closed));
  eq('closing it disarms the panel', t.el('tuning-arm').checked, false);
  eq('and the row says so', t.el('control-text').textContent, 'ctl idle');

  writes.sendTuningControl({ action: 'arm', armed: true });
  const again = t.sockets[2];
  check('the next write opens a fresh link', again && again.url.endsWith('/rb2/control'));
  again.open();
  again.receiveJson({ type: 'tuning_armed', armed: true });
  t.hide();
  check('hiding the tab closes it at once', again.closed && again.closed.reason === 'hidden',
    JSON.stringify(again.closed));
  eq('and disarms', t.el('tuning-arm').checked, false);
}

// ---------------------------------------------------------------------------
console.log('\nthe control link cannot corrupt the telemetry stream');
{
  const t = loadDashboard(SITE);
  const telemetry = t.sockets[0];
  telemetry.open();
  t.sandbox.window.__writeActions.sendStopwatchControl('reset');
  const control = t.sockets[1];
  control.open();
  control.receiveJson({ type: 'scan', bytes: 4, count: 2, encoding: 'u16mm' });
  control.receive(new ArrayBuffer(4));
  eq('a binary frame on the control link is ignored', t.warnings.length, 0);
  telemetry.receive(new ArrayBuffer(4));
  check('and a header on it never claimed the telemetry socket\'s next binary',
    t.warnings.some((w) => w.includes('binary frame with no header before it')), t.warnings.join(' | '));
}

// ---------------------------------------------------------------------------
console.log('\nthe link-state row');
{
  const t = loadDashboard(SITE);
  const telemetry = t.sockets[0];
  telemetry.open();
  eq('before the relay says anything', t.el('relay-text').textContent, 'relay --');
  telemetry.receiveJson({ type: 'relay_status', car_connected: false, viewers: 1, since: 0 });
  eq('relay up, car not', t.el('relay-text').textContent, 'car offline · 1 watching');
  eq('shown red', t.el('relay-dot').className, 'dot dot-red');
  telemetry.receiveJson({ type: 'relay_status', car_connected: true, viewers: 2, since: 0 });
  eq('car connected to the relay', t.el('relay-text').textContent, 'car online · 2 watching');
  eq('shown green', t.el('relay-dot').className, 'dot dot-green');
  telemetry.receiveJson({ type: 'hello', protocol_version: 1 });
  eq('a matching hello changes nothing visible', t.el('relay-text').className, '');

  const old = loadDashboard(SITE);
  old.sockets[0].open();
  old.sockets[0].receiveJson({ type: 'relay_status', car_connected: true, viewers: 1, since: 0 });
  old.sockets[0].receiveJson({ type: 'batch', items: [{ type: 'speed', speed: 1 }] });
  eq('a car that opens without a hello is version 0 and not flagged', old.el('relay-text').className, '');
  check('and the tooltip says why', old.el('relay-text').title.includes('predates versioning'), old.el('relay-text').title);

  const newer = loadDashboard(SITE);
  newer.sockets[0].open();
  newer.sockets[0].receiveJson({ type: 'relay_status', car_connected: true, viewers: 1, since: 0 });
  newer.sockets[0].receiveJson({ type: 'hello', protocol_version: 2 });
  eq('a mismatched hello turns the row red', newer.el('relay-text').className, 'link-bad');
  check('and names both versions', newer.el('relay-text').textContent.includes('car v2')
    && newer.el('relay-text').textContent.includes('site v1'), newer.el('relay-text').textContent);
  check('with the whole instruction in its tooltip',
    newer.el('relay-text').title.includes('update the car or redeploy the site'), newer.el('relay-text').title);

  telemetry.onclose();
  eq('a dropped relay link forgets what the relay said', t.el('relay-text').textContent, 'relay --');
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
