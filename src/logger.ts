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

function write(level: string, scope: string, message: string, meta?: JsonObject): void {
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

