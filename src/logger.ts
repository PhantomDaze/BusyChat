import type { JsonObject, Logger } from './types';

function serializeMeta(meta?: JsonObject): string {
  if (!meta) {
    return '';
  }

  try {
    return ` ${JSON.stringify(meta)}`;
  } catch {
    return ' {"meta":"<unserializable>"}';
  }
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

function resolveThreshold(): number {
  const raw = (process.env.LOG_LEVEL ?? '').trim().toLowerCase();
  const known = Object.prototype.hasOwnProperty.call(LEVEL_ORDER, raw);
  // Default to `info`: debug logs fire on every incoming message, which is far
  // too noisy for a normally-running bot.
  return known ? LEVEL_ORDER[raw as LogLevel] : LEVEL_ORDER.info;
}

// Read once at startup so the level check stays cheap on the hot path.
const THRESHOLD = resolveThreshold();

function write(level: LogLevel, scope: string, message: string, meta?: JsonObject): void {
  if (LEVEL_ORDER[level] < THRESHOLD) return;

  const line = `[${new Date().toISOString()}] [${level}] [${scope}] ${message}${serializeMeta(meta)}`;
  if (level === 'error') {
    console.error(line);
    return;
  }
  if (level === 'warn') {
    console.warn(line);
    return;
  }
  console.log(line);
}

export function createLogger(scope: string): Logger {
  return {
    scope,
    child(childScope: string): Logger {
      return createLogger(`${scope}:${childScope}`);
    },
    debug(message: string, meta?: JsonObject): void {
      write('debug', scope, message, meta);
    },
    info(message: string, meta?: JsonObject): void {
      write('info', scope, message, meta);
    },
    warn(message: string, meta?: JsonObject): void {
      write('warn', scope, message, meta);
    },
    error(message: string, meta?: JsonObject): void {
      write('error', scope, message, meta);
    },
  };
}

