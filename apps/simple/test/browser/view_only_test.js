'use strict';

const assert = require('assert/strict');
const { loadDashboard, SITE, settleAccess } = require('./control_link_test');

let checks = 0;
function check(name, condition) {
  assert.ok(condition, name);
  checks++;
  console.log(`  ok    ${name}`);
}

const MESSAGE = 'You can view this car but not change it';
const staticWrites = ['stopwatch-toggle', 'stopwatch-reset', 'tuning-arm', 'map-reset-slam'];
const descendants = (el) => el.children.flatMap((child) => [child, ...descendants(child)]);
const findClass = (el, name) => descendants(el).filter((child) => child.className.split(' ').includes(name));
const tuningInputs = (t) => descendants(t.el('tuning-body')).filter((el) =>
  ['range', 'number', 'checkbox'].includes(el.type) || el.className === 'tuning-revert');
const reply = (role, car = 'rb2') => ({ ok: true, json: async () => ({ car, role, via: 'oneportal' }) });

function publishPanels(t) {
  const telemetry = t.sockets[0];
  telemetry.open();
  telemetry.receiveJson({ type: 'tuning', enabled: true, allow_save: true, nodes: [{
    node: 'gap_follow_node', online: true, savable: true,
    params: [
      { name: 'speed', label: 'Speed', kind: 'float', min: 0, max: 5, step: 0.1, value: 1, baseline: 1 },
      { name: 'enabled', label: 'Enabled', kind: 'bool', value: true, baseline: true },
    ],
  }] });
  telemetry.receiveJson({ type: 'processes', enabled: true,
    targets: [{ pid: 42, name: 'driver', protected: false }] });
  telemetry.receiveJson({ type: 'saved_maps', enabled: true, can_delete: true, can_reset_slam: true,
    runs: [{ id: 'run', deletable: true, bytes: 10, digest: 'd' }] });
}

function invokeWrites(t) {
  const writes = t.sandbox.__writeActions;
  writes.sendStopwatchControl('set_enabled', true);
  writes.sendStopwatchControl('reset');
  writes.sendTuningControl({ action: 'arm', armed: true });
  writes.sendTuningControl({ action: 'set', node: 'n', name: 'speed', value: 1 });
  writes.sendTuningControl({ action: 'save' });
  writes.sendProcessControl({ action: 'stop', pid: 42 });
  writes.sendMapControl({ action: 'delete', id: 'run', confirm: 'run', digest: 'd' });
  writes.sendMapControl({ action: 'reset_slam' });
}

function checkView(t, label) {
  check(`${label}: role is view`, t.sandbox.__accessRole === 'view');
  check(`${label}: badge is visible`, !t.el('view-only-badge').hidden);
  check(`${label}: static writes disabled with explanation`, staticWrites.every((id) =>
    t.el(id).disabled && t.el(id).title === MESSAGE));
  check(`${label}: save disabled with explanation`, t.el('tuning-save').disabled
    && t.el('tuning-save').title === MESSAGE);
  const count = t.sockets.length;
  invokeWrites(t);
  check(`${label}: direct writes never open a control socket`, t.sockets.length === count);
}

async function main() {
  console.log('access pending, viewer UI and viewing operations');
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const viewer = loadDashboard(SITE, { fetch: () => pending });
  check('only telemetry opens at startup', viewer.sockets.length === 1 && viewer.sockets[0].url.endsWith('/ws'));
  checkView(viewer, 'pending');
  check('access uses the page car', viewer.requests[0].url === '/rb2/access');
  check('access uses same-origin credentials and bypasses cache',
    viewer.requests[0].init.credentials === 'same-origin' && viewer.requests[0].init.cache === 'no-store');
  publishPanels(viewer);
  check('viewer still receives tuning values', tuningInputs(viewer).length === 5);
  check('viewer tuning inputs are disabled with tooltips', tuningInputs(viewer).every((el) =>
    el.disabled && el.title === MESSAGE));
  check('viewer has no process stop buttons', findClass(viewer.el('proc-list'), 'proc-stop').length === 0);
  check('viewer has no map delete buttons', findClass(viewer.el('map-list'), 'map-delete').length === 0);
  resolve(reply('view'));
  await settleAccess();
  checkView(viewer, 'viewer');
  viewer.sandbox.__writeActions.sendMapControl({ action: 'clear_view' });
  check('clear view still uses telemetry', JSON.parse(viewer.sockets[0].sent[0]).action === 'clear_view');
  viewer.clock.advance(10000);
  check('telemetry heartbeat still runs', viewer.sockets[0].sent.includes('{"type":"relay_ping"}'));

  console.log('\ncontrollers retain write behavior, including after telemetry arrives before access');
  let allow;
  const controller = loadDashboard(SITE, { fetch: () => new Promise((done) => { allow = done; }) });
  publishPanels(controller);
  allow(reply('control'));
  await settleAccess();
  check('controller role exposed', controller.sandbox.__accessRole === 'control');
  check('controller badge hidden', controller.el('view-only-badge').hidden);
  check('controller static writes enabled', staticWrites.every((id) => !controller.el(id).disabled));
  check('process stop button restored', findClass(controller.el('proc-list'), 'proc-stop').length === 1);
  const deletes = findClass(controller.el('map-list'), 'map-delete');
  check('map delete button restored', deletes.length === 1);
  const field = findClass(controller.el('map-list'), 'map-confirm-input')[0];
  field.value = 'run';
  field.emit('input');
  check('matching name enables delete', !deletes[0].disabled);
  check('tuning still requires arming', tuningInputs(controller).every((el) => el.disabled));
  invokeWrites(controller);
  check('controller opens exactly one control socket', controller.sockets.length === 2);
  const control = controller.sockets[1];
  control.open();
  check('all eight write actions reach control', control.sent.length === 8);
  control.receiveJson({ type: 'tuning_armed', armed: true });
  check('arming enables tuning inputs and save', tuningInputs(controller).every((el) => !el.disabled)
    && !controller.el('tuning-save').disabled);
  check('controller tooltips no longer say view only', tuningInputs(controller).every((el) => el.title !== MESSAGE));
  check('writes never reach telemetry', controller.sockets[0].sent.length === 0);
  control.close(1008, 'You can view this car but not change it.');
  checkView(controller, 'server refusal');
  check('refusal shown in error style', controller.el('control-text').textContent === MESSAGE
    && controller.el('control-text').className.includes('link-bad'));
  check('refusal disarms tuning', !controller.el('tuning-arm').checked);
  check('refusal removes dynamic writes', findClass(controller.el('proc-list'), 'proc-stop').length === 0
    && findClass(controller.el('map-list'), 'map-delete').length === 0);

  for (const role of ['view', 'control']) {
    let calls = 0;
    const t = loadDashboard(SITE, { fetch: async () => reply(++calls === 1 ? 'control' : role) });
    await settleAccess();
    t.sandbox.__writeActions.sendStopwatchControl('reset');
    t.sockets[1].close(1006, '');
    check('abnormal close checks access again', t.requests.length === 2);
    check('access recheck locks writes while pending', t.sandbox.__accessRole === 'view');
    await settleAccess();
    check(`abnormal close resolves current ${role} role`, t.sandbox.__accessRole === role);
    check(`abnormal close ${role} status`, role === 'view'
      ? t.el('control-text').textContent === MESSAGE : t.el('control-text').textContent === 'ctl idle');
  }

  console.log('\naccess failures fail closed');
  for (const [label, fetch] of [
    ['401', async () => ({ ok: false, status: 401 })],
    ['403', async () => ({ ok: false, status: 403 })],
    ['network', async () => { throw new Error('offline'); }],
    ['invalid JSON', async () => ({ ok: true, json: async () => { throw new Error('invalid JSON'); } })],
    ['unknown role', async () => reply('owner')],
    ['wrong car', async () => reply('control', 'other')],
  ]) {
    const t = loadDashboard(SITE, { fetch });
    await settleAccess();
    checkView(t, label);
  }

  console.log('\naccess stays same-origin with existing localhost overrides');
  const local = loadDashboard({ ...SITE, protocol: 'http:', hostname: 'localhost', host: 'localhost:8787',
    search: '?ws=ws://localhost:8090/ws&control=ws://localhost:8090/control&access=https://evil.example/access' });
  await settleAccess();
  check('access cannot be redirected by overrides', local.requests[0].url === '/rb2/access');
  check('existing local telemetry override still works', local.sockets[0].url === 'ws://localhost:8090/ws');
  local.sandbox.__writeActions.sendStopwatchControl('reset');
  check('existing local control override still works after authorization', local.sockets[1].url === 'ws://localhost:8090/control');
  const remote = loadDashboard({ ...SITE, search: '?access=https://evil.example&control=wss://evil.example' });
  await settleAccess();
  check('remote access stays same-origin', remote.requests[0].url === '/rb2/access');
  remote.sandbox.__writeActions.sendStopwatchControl('reset');
  check('remote control override is ignored', remote.sockets[1].url === 'wss://dashboard.sfuracerbot.ca/rb2/control');

  console.log(`\n${checks}/${checks} checks passed`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
