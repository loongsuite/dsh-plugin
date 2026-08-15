/**
 * Local DeepSeek Harness event tap for LoongSuite Pilot.
 *
 * The plugin writes the public session event stream to collector-compatible
 * JSONL files. It has no network client and contains event-write failures
 * after load so observability cannot interrupt an active session.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const AGENT = 'loongsuite-pilot-observability';
const LOAD_MARKER = Symbol.for('loongsuite-pilot.dsh.tap.loaded');
const SENSITIVE_KEY_RE = /(^|[_.-])(TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE|API_?KEY)([_.-]|$)/;
const COLLECTOR_INSTALL_COMMAND = 'curl -fsSL https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/installer.sh -o /tmp/loongsuite-pilot-installer.sh && bash /tmp/loongsuite-pilot-installer.sh install';

function dataDir() {
  return process.env.LOONGSUITE_PILOT_DATA_DIR
    || process.env.PILOT_DATA
    || path.join(os.homedir(), '.loongsuite-pilot');
}

function logDir(root) {
  return path.join(root, 'logs', 'dsh');
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(dir, 0o700);
}

function sessionFile(dir, sid) {
  const safe = String(sid).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(dir, `dsh-${safe}.jsonl`);
}

function isSensitiveKey(key) {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
  return SENSITIVE_KEY_RE.test(normalized);
}

function redact(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redact);
  const output = {};
  for (const [key, nested] of Object.entries(value)) {
    if (isSensitiveKey(key)) continue;
    output[key] = redact(nested);
  }
  return output;
}

function appendLine(file, record) {
  if (!existsSync(file)) ensureDir(path.dirname(file));
  appendFileSync(file, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') chmodSync(file, 0o600);
}

function appendSafely(logger, file, record) {
  try {
    appendLine(file, record);
  } catch (error) {
    logger.warn('failed to append dsh telemetry file=%s error=%s', file, String(error));
  }
}

function commandOnPath(command) {
  const searchPath = process.env.PATH;
  if (!searchPath) return false;
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  return searchPath.split(path.delimiter).some((dir) =>
    extensions.some((extension) => existsSync(path.join(dir, `${command}${extension}`))));
}

function collectorDetected(root) {
  return [
    path.join(root, 'config.json'),
    path.join(root, 'package'),
    path.join(root, 'current'),
    path.join(root, 'versions'),
  ].some(existsSync) || commandOnPath('loongsuite-pilot');
}

/** Install the local event tap into a Cordis context. */
export default function apply(ctx) {
  const logger = ctx.logger(AGENT);
  if (globalThis[LOAD_MARKER] !== undefined) {
    logger.warn('duplicate plugin load ignored; one LoongSuite Pilot dsh tap is already active');
    return;
  }

  const root = dataDir();
  const outputDir = logDir(root);
  const hasCollector = collectorDetected(root);
  ensureDir(outputDir);

  const owner = {};
  globalThis[LOAD_MARKER] = owner;
  ctx.effect(() => () => {
    if (globalThis[LOAD_MARKER] === owner) delete globalThis[LOAD_MARKER];
  }, 'loongsuite-pilot dsh tap marker');

  appendSafely(logger, path.join(outputDir, `dsh-${process.pid}.jsonl`), {
    type: `${AGENT}/loaded`,
    logDir: outputDir,
    time: Date.now(),
  });

  ctx.on('session/created', (session) => {
    appendSafely(logger, sessionFile(outputDir, session.id), {
      type: 'session/created',
      sid: String(session.id),
      time: Date.now(),
    });
  });

  ctx.on('session/event', (session, event) => {
    appendSafely(logger, sessionFile(outputDir, session.id), {
      sid: String(session.id),
      seq: event.seq,
      time: event.time,
      type: event.type,
      data: redact(event.data),
    });
  });

  logger.info('plugin loaded; logDir=%s', outputDir);
  if (!hasCollector) {
    logger.warn('LoongSuite Pilot collector not detected; events remain local in %s. Install the collector with: %s', outputDir, COLLECTOR_INSTALL_COMMAND);
  }
}
