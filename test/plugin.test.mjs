import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

const LOAD_MARKER = Symbol.for('loongsuite-pilot.dsh.tap.loaded');
const originalDataDir = process.env.LOONGSUITE_PILOT_DATA_DIR;
const originalPilotData = process.env.PILOT_DATA;
const originalPath = process.env.PATH;
const temporaryRoots = [];

function temporaryRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pilot-dsh-'));
  temporaryRoots.push(root);
  process.env.LOONGSUITE_PILOT_DATA_DIR = root;
  delete process.env.PILOT_DATA;
  process.env.PATH = '';
  return root;
}

function contextHarness() {
  const listeners = new Map();
  const disposers = [];
  const logs = [];
  const namedLogger = {
    info: (...args) => logs.push({ level: 'info', args }),
    warn: (...args) => logs.push({ level: 'warn', args }),
  };
  return {
    ctx: {
      effect: (initialize) => {
        disposers.push(initialize());
      },
      logger: () => namedLogger,
      on: (name, listener) => {
        const registered = listeners.get(name) || [];
        registered.push(listener);
        listeners.set(name, registered);
      },
    },
    emit(name, ...args) {
      for (const listener of listeners.get(name) || []) listener(...args);
    },
    listenerCount(name) {
      return (listeners.get(name) || []).length;
    },
    logs,
    dispose() {
      for (const disposer of disposers.reverse()) disposer();
    },
  };
}

function records(file) {
  return readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
}

async function loadPlugin(tag) {
  return (await import(new URL(`../index.mjs?test=${tag}-${Math.random()}`, import.meta.url))).default;
}

afterEach(() => {
  delete globalThis[LOAD_MARKER];
  if (originalDataDir === undefined) delete process.env.LOONGSUITE_PILOT_DATA_DIR;
  else process.env.LOONGSUITE_PILOT_DATA_DIR = originalDataDir;
  if (originalPilotData === undefined) delete process.env.PILOT_DATA;
  else process.env.PILOT_DATA = originalPilotData;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('writes collector-compatible records with private permissions and capture-time redaction', async () => {
  const root = temporaryRoot();
  const harness = contextHarness();
  const apply = await loadPlugin('records');
  apply(harness.ctx);

  const session = { id: 'session/one' };
  harness.emit('session/created', session);
  harness.emit('session/event', session, {
    seq: 7,
    time: 1_234,
    type: 'request/header',
    data: {
      apiKey: 'remove-me',
      authToken: 'remove-me-too',
      tokenizer: 'keep-me',
      nested: [{ PASSWORD: 'remove-me-three', value: 'visible' }],
    },
  });

  const dir = path.join(root, 'logs', 'dsh');
  const file = path.join(dir, 'dsh-session_one.jsonl');
  const output = records(file);
  if (process.platform !== 'win32') {
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }
  assert.deepEqual(output[0], {
    type: 'session/created',
    sid: 'session/one',
    time: output[0].time,
  });
  assert.deepEqual(output[1], {
    sid: 'session/one',
    seq: 7,
    time: 1_234,
    type: 'request/header',
    data: {
      tokenizer: 'keep-me',
      nested: [{ value: 'visible' }],
    },
  });
  harness.dispose();
});

test('uses a process-wide guard across independently imported module copies', async () => {
  temporaryRoot();
  const first = contextHarness();
  const duplicate = contextHarness();
  const applyFirst = await loadPlugin('first');
  const applyDuplicate = await loadPlugin('duplicate');

  applyFirst(first.ctx);
  applyDuplicate(duplicate.ctx);
  assert.equal(first.listenerCount('session/event'), 1);
  assert.equal(duplicate.listenerCount('session/event'), 0);
  assert.match(String(duplicate.logs.find(log => log.level === 'warn')?.args[0]), /duplicate plugin load ignored/);

  first.dispose();
  const reloaded = contextHarness();
  applyDuplicate(reloaded.ctx);
  assert.equal(reloaded.listenerCount('session/event'), 1);
  reloaded.dispose();
});

test('reports collector absence once and recognizes an installed data directory', async () => {
  const missingRoot = temporaryRoot();
  const missing = contextHarness();
  const apply = await loadPlugin('collector-missing');
  apply(missing.ctx);
  const hints = missing.logs.filter(log => String(log.args[0]).includes('collector not detected'));
  assert.equal(hints.length, 1);
  assert.equal(hints[0].args[1], path.join(missingRoot, 'logs', 'dsh'));
  missing.dispose();

  const installedRoot = temporaryRoot();
  writeFileSync(path.join(installedRoot, 'config.json'), '{}\n');
  const installed = contextHarness();
  apply(installed.ctx);
  assert.equal(installed.logs.some(log => String(log.args[0]).includes('collector not detected')), false);
  installed.dispose();
});

test('contains event write failures after a successful plugin load', async () => {
  const root = temporaryRoot();
  const harness = contextHarness();
  const apply = await loadPlugin('write-failure');
  apply(harness.ctx);

  const dir = path.join(root, 'logs', 'dsh');
  rmSync(dir, { recursive: true });
  mkdirSync(path.dirname(dir), { recursive: true });
  writeFileSync(dir, 'not a directory');

  assert.doesNotThrow(() => {
    harness.emit('session/event', { id: 'session' }, {
      seq: 1,
      time: 2,
      type: 'turn/start',
      data: { turn: 1 },
    });
  });
  assert.equal(harness.logs.some(log => String(log.args[0]).includes('failed to append dsh telemetry')), true);
  harness.dispose();
});

test('writes one process lifecycle record on load', async () => {
  const root = temporaryRoot();
  const harness = contextHarness();
  const apply = await loadPlugin('lifecycle');
  apply(harness.ctx);

  const dir = path.join(root, 'logs', 'dsh');
  const processFile = readdirSync(dir).find(name => name === `dsh-${process.pid}.jsonl`);
  assert.ok(processFile);
  assert.deepEqual(records(path.join(dir, processFile))[0], {
    type: 'loongsuite-pilot-observability/loaded',
    logDir: dir,
    time: records(path.join(dir, processFile))[0].time,
  });
  harness.dispose();
});
