#!/usr/bin/env node
// CPU-based autoscaler for the compose `api` service — the compose-level
// equivalent of a k8s HPA. Node is single-threaded, so one replica saturates
// at ~1 core; adding replicas on a multicore host adds real capacity. The
// architecture makes membership elastic: Envoy STRICT_DNS discovers new
// replicas within its DNS refresh, the Redis bus fans events out to them, and
// on scale-in dropped WebSocket clients auto-reconnect to survivors.
//
//   node tools/autoscaler.mjs            # scales project relay-load
//   PROJECT=c1-take-home node tools/autoscaler.mjs
//
// Scale up:   avg CPU > UP_CPU for UP_TICKS consecutive ticks (fast).
// Scale down: avg CPU < DOWN_CPU for DOWN_TICKS consecutive ticks (slow).
// A cooldown after each action prevents flapping.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const PROJECT = process.env.PROJECT ?? 'relay-load';
const FILES = PROJECT === 'relay-load'
  ? ['-f', 'docker-compose.yml', '-f', 'docker-compose.loadtest.yml']
  : [];
const COMPOSE = ['compose', '-p', PROJECT, ...FILES];

const MIN = Number(process.env.MIN ?? 2);
const MAX = Number(process.env.MAX ?? 6);
const UP_CPU = Number(process.env.UP_CPU ?? 70); // % of one core, per replica avg
const DOWN_CPU = Number(process.env.DOWN_CPU ?? 25);
const TICK_MS = Number(process.env.TICK_MS ?? 10_000);
const UP_TICKS = 2;
const DOWN_TICKS = 6;
const COOLDOWN_MS = 30_000;

let hot = 0;
let cold = 0;
let lastScaleAt = 0;

const log = (msg) => console.log(`[autoscaler ${new Date().toISOString()}] ${msg}`);

async function replicaIds() {
  const { stdout } = await run('docker', [...COMPOSE, 'ps', '-q', 'api']);
  return stdout.trim().split('\n').filter(Boolean);
}

async function avgCpu(ids) {
  const { stdout } = await run('docker', ['stats', '--no-stream', '--format', '{{.CPUPerc}}', ...ids]);
  const vals = stdout.trim().split('\n').map((s) => parseFloat(s)).filter((v) => !Number.isNaN(v));
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
}

async function scaleTo(n, why) {
  log(`scaling api -> ${n} replicas (${why})`);
  await run('docker', [...COMPOSE, 'up', '-d', '--no-deps', '--no-recreate', '--scale', `api=${n}`, 'api']);
  lastScaleAt = Date.now();
  hot = 0;
  cold = 0;
}

log(`watching project=${PROJECT} min=${MIN} max=${MAX} up>${UP_CPU}% down<${DOWN_CPU}%`);
for (;;) {
  try {
    const ids = await replicaIds();
    const cpu = await avgCpu(ids);
    const coolingDown = Date.now() - lastScaleAt < COOLDOWN_MS;
    log(`replicas=${ids.length} avgCpu=${cpu.toFixed(1)}%${coolingDown ? ' (cooldown)' : ''}`);

    if (!coolingDown) {
      hot = cpu > UP_CPU ? hot + 1 : 0;
      cold = cpu < DOWN_CPU ? cold + 1 : 0;
      if (hot >= UP_TICKS && ids.length < MAX) await scaleTo(ids.length + 1, `cpu ${cpu.toFixed(0)}% > ${UP_CPU}%`);
      else if (cold >= DOWN_TICKS && ids.length > MIN) await scaleTo(ids.length - 1, `cpu ${cpu.toFixed(0)}% < ${DOWN_CPU}%`);
    }
  } catch (err) {
    log(`error: ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, TICK_MS));
}
