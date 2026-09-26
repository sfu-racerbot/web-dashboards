// The mock car's behaviour, independent of sockets: what each role gets,
// and what each write action does. server.mjs wires it to WebSockets.
//
// It follows the car contract in docs/decisions.md ("The car contract"):
//   - every connection's first message is {"type":"hello","protocol_version":N}
//   - role=relay: the full telemetry stream, as dashboard_node sends today;
//     every write action is refused
//   - role=control: hello and the state the write panels need (tuning,
//     processes, saved runs, stopwatch) plus replies; no map/scan/batch;
//     writes work, and tuning arming is per connection

import { MapStream, Reveal, buildTruth, intentPayload, poseAt, scan, scanFrame, targetSpeed } from './world.mjs';

const DT_BATCH = 1 / 20;

function tuningSpec(node) {
  const common = [
    { name: 'max_speed', group: 'Speed', label: 'max speed', kind: 'float', min: 0.5, max: 6, step: 0.1, unit: 'm/s', safety: false, description: 'Top speed on a straight.' },
    { name: 'min_speed', group: 'Speed', label: 'min speed', kind: 'float', min: 0.2, max: 3, step: 0.1, unit: 'm/s', safety: false, description: 'Slowest the controller will command while moving.' },
    { name: 'emergency_stop_distance', group: 'Safety margins', label: 'emergency stop distance', kind: 'float', min: 0.1, max: 2, step: 0.05, unit: 'm', safety: true, description: 'Stop if anything is closer than this ahead.' },
  ];
  if (node === 'pure_pursuit_node') {
    common.push({ name: 'lookahead_distance', group: 'Line following', label: 'lookahead', kind: 'float', min: 0.3, max: 3, step: 0.05, unit: 'm', safety: false, description: 'How far ahead the steering target sits.' });
    common.push({ name: 'enable_overtake', group: 'Overtaking', label: 'overtaking', kind: 'bool', min: 0, max: 1, step: 0, unit: '', safety: false, description: 'Allow passing manoeuvres.' });
  }
  return common;
}

const BASELINE = {
  pure_pursuit_node: { max_speed: 3, min_speed: 1, emergency_stop_distance: 0.4, lookahead_distance: 1.2, enable_overtake: false },
  gap_follow_node: { max_speed: 1.5, min_speed: 0.5, emergency_stop_distance: 0.35 },
};

export class MockCar {
  constructor({ protocolVersion = 1, sendHello = true, keyframeSec = 30 } = {}) {
    this.protocolVersion = protocolVersion;
    this.sendHello = sendHello;
    this.keyframeSec = keyframeSec;
    this.truth = buildTruth();
    this.reveal = new Reveal(this.truth);
    this.mapStream = new MapStream();
    this.t = 0;
    this.lastKeyframeAt = 0;
    this.blinkOn = false;
    this.startedAt = Date.now();
    this.pose = poseAt(0);
    this.speed = 0;
    this.intentState = { state: 'pure_pursuit', severity: 'drive', since: Date.now() };
    this.stopUntil = 0;
    this.stopwatch = { enabledAt: null, elapsed: 0, enabled: false };
    this.values = JSON.parse(JSON.stringify(BASELINE));
    this.processes = [
      { pid: 4242, name: 'pure_pursuit_node', kind: 'node', cmdline: '/usr/bin/python3 .../pure_pursuit_node', protected: false, reason: '' },
      { pid: 4243, name: 'gap_follow_node', kind: 'node', cmdline: '/usr/bin/python3 .../gap_follow_node', protected: false, reason: '' },
      { pid: 99, name: 'ackermann_mux', kind: 'node', cmdline: '.../ackermann_mux', protected: true, reason: 'in the actuation path -- stopping it would leave a moving car that releasing LB can no longer stop' },
    ];
    // Stats and stopwatch are queued into the next batch, as the car's
    // TelemetryBatcher does -- they never get frames of their own.
    this.pendingItems = new Map();
    this.runs = [
      this.run('20260920-101500', 29_383_000, ['map', 'pose graph', 'racing line']),
      this.run('20260921-140210', 12_004_000, ['map', 'pose graph']),
    ];
    this.reveal.around(this.pose);
    this.mapStream.keyframe(this.reveal.cells);
    this.lastKeyframeAt = Date.now();
  }

  run(id, bytes, contents) {
    return {
      id, root: '~/.ros/racerbot_auto', path: `/home/racerbot/.ros/racerbot_auto/${id}`,
      has_map: true, has_posegraph: contents.includes('pose graph'), contents, bytes, mtime: Date.now() / 1000,
      width: 480, height: 320, resolution: 0.05, origin: [-12, -8, 0], span_m: [24, 16], unknown: [],
      deletable: true, reason: '', digest: `digest-${id}`, cited_by: '',
    };
  }

  // -- messages ---------------------------------------------------------------

  hello() {
    return this.sendHello ? [{ type: 'hello', protocol_version: this.protocolVersion }] : [];
  }

  tuningState() {
    return {
      type: 'tuning', enabled: true, allow_save: true, stamp: Date.now() / 1000,
      nodes: Object.keys(BASELINE).map((node) => ({
        node, online: true, driving: node === 'pure_pursuit_node', error: null, savable: true,
        config_path: `/home/racerbot/racerbot-ws/src/${node.replace('_node', '')}/config/${node.replace('_node', '')}.yaml`,
        params: tuningSpec(node).map((p) => ({ ...p, value: this.values[node][p.name], baseline: BASELINE[node][p.name] })),
      })),
    };
  }

  processState() {
    return { type: 'processes', enabled: true, targets: this.processes, stamp: Date.now() / 1000 };
  }

  savedMaps() {
    return {
      type: 'saved_maps', enabled: true, can_delete: true, can_reset_slam: true,
      roots: ['~/.ros/racerbot_auto', '~/.ros/racerbot_sim/auto'], runs: this.runs, stamp: Date.now() / 1000,
    };
  }

  stopwatchMessage() {
    const running = this.stopwatch.enabled && this.stopwatch.enabledAt !== null;
    const elapsed = this.stopwatch.elapsed + (running ? (Date.now() - this.stopwatch.enabledAt) / 1000 : 0);
    return {
      type: 'stopwatch', elapsed_s: elapsed, enabled: this.stopwatch.enabled, running,
      lb_held: true, joy_fresh: true, button_available: true, stamp: Date.now() / 1000,
    };
  }

  statsMessage() {
    const up = (Date.now() - this.startedAt) / 1000;
    return {
      type: 'stats', cpu_percent: 35 + 10 * Math.sin(up / 7), mem_percent: 41, cpu_temp_c: 52 + 3 * Math.sin(up / 13),
      uptime_s: 3600 + up, wifi_dbm: -58, stamp: Date.now() / 1000,
    };
  }

  /** What a new connection of this role is sent first, as [header, payload?] pairs. */
  initialFrames(role) {
    const frames = this.hello().map((h) => ({ header: h }));
    if (role === 'control') {
      frames.push({ header: this.tuningState() }, { header: { type: 'tuning_armed', armed: false, stamp: Date.now() / 1000 } });
      frames.push({ header: this.processState() }, { header: this.savedMaps() }, { header: this.stopwatchMessage() });
      return frames;
    }
    const map = this.mapStream.current();
    if (map) frames.push(map);
    frames.push(scanFrame(scan(this.truth, this.pose)));
    frames.push({ header: { type: 'pose', x: this.pose.x, y: this.pose.y, yaw: this.pose.yaw, stamp: Date.now() / 1000 } });
    frames.push({ header: this.statsMessage() }, { header: this.stopwatchMessage() });
    frames.push({ header: this.tuningState() }, { header: { type: 'tuning_armed', armed: false, stamp: Date.now() / 1000 } });
    frames.push({ header: this.processState() }, { header: this.savedMaps() });
    return frames;
  }

  // -- the world ticking ------------------------------------------------------

  /** Advance 1/20 s and return the batch frame for relay connections. */
  tickBatch() {
    const now = Date.now();
    const here = poseAt(this.t);
    const stopping = now < this.stopUntil;
    if (!stopping && now - this.intentState.since > 25_000 && this.intentState.state !== 'emergency_stop') {
      // Every 25 s, a short stop, so the decision log has transitions.
      this.stopUntil = now + 1500;
    }
    const want = now < this.stopUntil ? 0 : Math.min(targetSpeed(here.curvature), this.values.pure_pursuit_node.max_speed);
    this.speed += Math.max(-0.4, Math.min(0.2, want - this.speed));
    if (this.speed < 0.05 && want === 0) this.speed = 0;
    this.t += (this.speed * DT_BATCH) / here.dsdt;
    this.pose = poseAt(this.t);

    let state = 'pure_pursuit'; let severity = 'drive'; let reason;
    if (want === 0) { state = 'emergency_stop'; severity = 'stop'; reason = 'obstacle 0.35 m ahead (mock)'; }
    else if (Math.abs(here.curvature) > 0.25) { state = 'corner_slowdown'; severity = 'caution'; reason = 'curvature cap is binding'; }
    if (state !== this.intentState.state) this.intentState = { state, severity, since: now };

    const items = [
      ...this.pendingItems.values(),
      { type: 'pose', x: this.pose.x, y: this.pose.y, yaw: this.pose.yaw, stamp: now / 1000 },
      { type: 'drive', speed: want, steering_angle: Math.atan(0.36 * here.curvature), stamp: now / 1000 },
      { type: 'speed', speed: this.speed, stamp: now / 1000 },
      { type: 'intent', intent: intentPayload({ t: this.t, dtdS: 1 / here.dsdt, state, severity, speed: this.speed, reason: reason ?? 'following the racing line' }), stamp: now / 1000 },
    ];
    this.pendingItems.clear();
    return { header: { type: 'batch', items } };
  }

  /** Queue the stopwatch for the next batch; also returned for control connections. */
  tickStopwatch() {
    const message = this.stopwatchMessage();
    this.pendingItems.set('stopwatch', message);
    return { header: message };
  }

  tickStats() { this.pendingItems.set('stats', this.statsMessage()); }
  tickScan() { return scanFrame(scan(this.truth, this.pose)); }

  /** Once a second: reveal, then a patch, a keyframe, or nothing. */
  tickMap() {
    this.reveal.around(this.pose);
    this.blinkOn = !this.blinkOn;
    this.reveal.blink(this.blinkOn);
    if (Date.now() - this.lastKeyframeAt >= this.keyframeSec * 1000) {
      this.lastKeyframeAt = Date.now();
      return this.mapStream.keyframe(this.reveal.cells);
    }
    return this.mapStream.update(this.reveal.cells);
  }

  // -- write actions ----------------------------------------------------------

  /**
   * Handle one browser message on a connection.
   * Returns { reply: [...frames to this connection], broadcast: [...frames to every connection] }.
   */
  handle(conn, message) {
    const reply = [];
    const broadcast = [];
    const kind = message && message.type;
    const stamp = Date.now() / 1000;
    if (conn.role !== 'control') {
      const why = 'writes are refused on the relay connection; use role=control';
      if (kind === 'tuning_control') reply.push({ header: { type: 'tuning_result', node: String(message.node || ''), name: String(message.name || ''), ok: false, value: null, reason: why, stamp } });
      else if (kind === 'process_control') reply.push({ header: { type: 'process_result', pid: Number(message.pid) || 0, name: '', ok: false, done: true, detail: why, sent: [], stamp } });
      else if (kind === 'map_control' && message.action === 'reset_slam') reply.push({ header: { type: 'slam_reset_result', ok: false, done: true, detail: why, stamp } });
      else if (kind === 'map_control') reply.push({ header: { type: 'map_delete_result', id: String(message.id || ''), ok: false, detail: why, freed_bytes: 0, stamp } });
      return { reply, broadcast, refused: true };
    }

    if (kind === 'stopwatch_control') {
      if (message.action === 'set_enabled') {
        if (message.enabled && !this.stopwatch.enabled) { this.stopwatch.enabled = true; this.stopwatch.enabledAt = Date.now(); }
        if (!message.enabled && this.stopwatch.enabled) {
          this.stopwatch.elapsed += (Date.now() - this.stopwatch.enabledAt) / 1000;
          this.stopwatch.enabled = false; this.stopwatch.enabledAt = null;
        }
      } else if (message.action === 'reset') {
        this.stopwatch.elapsed = 0;
        if (this.stopwatch.enabled) this.stopwatch.enabledAt = Date.now();
      }
      broadcast.push({ header: this.stopwatchMessage() });
    } else if (kind === 'tuning_control') {
      if (message.action === 'arm') {
        conn.armed = !!message.armed;
        reply.push({ header: { type: 'tuning_armed', armed: conn.armed, stamp } });
      } else if (!conn.armed) {
        reply.push({ header: { type: 'tuning_result', node: String(message.node || ''), name: String(message.name || ''), ok: false, value: null, reason: 'tuning is not armed on this connection', stamp } });
      } else if (message.action === 'set') {
        const node = String(message.node);
        const spec = (tuningSpec(node) || []).find((p) => p.name === message.name);
        if (!this.values[node] || !spec) {
          reply.push({ header: { type: 'tuning_result', node, name: String(message.name), ok: false, value: null, reason: 'unknown parameter', stamp } });
        } else {
          const value = spec.kind === 'bool' ? !!message.value : Math.min(spec.max, Math.max(spec.min, Number(message.value)));
          this.values[node][spec.name] = value;
          broadcast.push({ header: { type: 'tuning_result', node, name: spec.name, ok: true, value, reason: '', stamp } });
          broadcast.push({ header: this.tuningState() });
        }
      } else if (message.action === 'save') {
        broadcast.push({ header: { type: 'tuning_saved', ok: true, detail: 'saved (mock: nothing was written)', files: [], stamp } });
      }
    } else if (kind === 'process_control' && message.action === 'stop') {
      const target = this.processes.find((p) => p.pid === Number(message.pid));
      if (!target || target.protected) {
        reply.push({ header: { type: 'process_result', pid: Number(message.pid) || 0, name: target ? target.name : '', ok: false, done: true, detail: target ? 'refused -- in the actuation path' : 'no such driving process', sent: [], stamp } });
      } else {
        broadcast.push({ header: { type: 'process_result', pid: target.pid, name: target.name, ok: true, done: false, detail: 'stopping...', sent: ['SIGINT'], stamp } });
        this.processes = this.processes.filter((p) => p !== target);
        broadcast.push({ header: { type: 'process_result', pid: target.pid, name: target.name, ok: true, done: true, detail: 'stopped', sent: ['SIGINT'], stamp } });
        broadcast.push({ header: this.processState() });
      }
    } else if (kind === 'map_control' && message.action === 'delete') {
      const run = this.runs.find((r) => r.id === message.id);
      if (!run) reply.push({ header: { type: 'map_delete_result', id: String(message.id), ok: false, detail: 'no such run', freed_bytes: 0, stamp } });
      else if (message.confirm !== run.id) reply.push({ header: { type: 'map_delete_result', id: run.id, ok: false, detail: 'the typed name does not match', freed_bytes: 0, stamp } });
      else if (message.digest !== run.digest) reply.push({ header: { type: 'map_delete_result', id: run.id, ok: false, detail: 'delete refused -- this run changed; refresh', freed_bytes: 0, stamp } });
      else {
        this.runs = this.runs.filter((r) => r !== run);
        broadcast.push({ header: { type: 'map_delete_result', id: run.id, ok: true, detail: `deleted, ${(run.bytes / 1e6).toFixed(1)} MB freed (mock)`, freed_bytes: run.bytes, stamp } });
        broadcast.push({ header: this.savedMaps() });
      }
    } else if (kind === 'map_control' && message.action === 'reset_slam') {
      broadcast.push({ header: { type: 'slam_reset_result', ok: true, done: false, detail: 'resetting SLAM...', stamp } });
      this.reveal = new Reveal(this.truth);
      this.reveal.around(this.pose);
      this.lastKeyframeAt = Date.now();
      broadcast.push({ ...this.mapStream.keyframe(this.reveal.cells), relayOnly: true });
      broadcast.push({ header: { type: 'slam_reset_result', ok: true, done: true, detail: 'SLAM reset', stamp } });
    } else if (kind === 'map_control' && message.action === 'clear_view') {
      const map = this.mapStream.current();
      reply.push({ header: { type: 'map_cleared', has_map: !!map, stamp } });
    } else if (kind === 'map_control' && message.action === 'refresh') {
      reply.push({ header: this.savedMaps() });
    } else if (kind === 'process_control' && message.action === 'refresh') {
      reply.push({ header: this.processState() });
    }
    return { reply, broadcast, refused: false };
  }
}
