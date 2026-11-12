import * as path from 'node:path';

import { BotApplication } from './app';
import { DEFAULT_CONFIG_PATH, loadAppConfigFile } from './config-store';
import { createLogger } from './logger';
import type { AppSettings } from './types';

function readEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseBooleanEnv(name: string, raw: string): boolean {
  const value = raw.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new Error(`invalid ${name}: expected true/false, got "${raw}"`);
}

function resolveConfigPath(): string {
  const override = readEnv('BUSYCHAT_CONFIG');
  return override ? path.resolve(override) : DEFAULT_CONFIG_PATH;
}

/** 环境变量覆盖配置文件中的进程级设置（优先级：env > config.json > 默认值）。 */
function applyEnvOverrides(settings: AppSettings): void {
  const dataDir = readEnv('BUSYCHAT_DATA_DIR');
  if (dataDir) settings.dataDir = path.resolve(dataDir);

  const host = readEnv('BUSYCHAT_HOST');
  if (host) settings.host = host;

  const port = readEnv('BUSYCHAT_PORT');
  if (port) {
    const parsed = Number(port);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      throw new Error(`invalid BUSYCHAT_PORT: "${port}"`);
    }
    settings.port = parsed;
  }

  const trustProxy = readEnv('BUSYCHAT_TRUST_PROXY');
  if (trustProxy) {
    settings.trustProxy = parseBooleanEnv('BUSYCHAT_TRUST_PROXY', trustProxy);
  }

  // 保证下游看到的始终是绝对路径。
  settings.dataDir = path.resolve(settings.dataDir);
}

async function main(): Promise<void> {
  const logger = createLogger('bootstrap');
  const configPath = resolveConfigPath();
  const config = await loadAppConfigFile(configPath);
  applyEnvOverrides(config.settings);
  logger.info('config loaded', {
    filePath: configPath,
    dataDir: config.settings.dataDir,
  });

  const app = new BotApplication(config.settings, configPath);

  // Memoize the promise (not a boolean): a second signal or an exception
  // during shutdown must WAIT for the in-flight stop, not return immediately
  // and process.exit() while the store flush is mid-write.
  let shutdownPromise: Promise<number> | null = null;
  const shutdown = (): Promise<number> => {
    shutdownPromise ??= (async () => {
      try {
        await app.stop();
        return 0;
      } catch (error) {
        logger.error('failed to stop application', {
          error: error instanceof Error ? error.message : String(error),
        });
        return 1;
      }
    })();
    return shutdownPromise;
  };

  process.once('SIGINT', () => {
    void shutdown().then((code) => process.exit(code));
  });

  process.once('SIGTERM', () => {
    void shutdown().then((code) => process.exit(code));
  });

  // Background promises are intentionally fire-and-forget in several places;
  // surface rather than crash on an unexpected rejection, and try to flush
  // state on a truly uncaught exception before exiting.
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled promise rejection', {
      error: reason instanceof Error ? reason.stack ?? reason.message : String(reason),
    });
  });

  process.on('uncaughtException', (error) => {
    logger.error('uncaught exception, shutting down', {
      error: error instanceof Error ? error.stack ?? error.message : String(error),
    });
    void shutdown().then((code) => process.exit(code || 1));
  });

  try {
    await app.start();
  } catch (error) {
    // Start failed partway through; tear down so the summary interval and
    // other timers don't keep a half-initialized process alive forever.
    await shutdown();
    throw error;
  }
}

void main().catch((error) => {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  // 直接写 stderr：LOG_LEVEL=silent 不能把致命启动错误也吞掉。
  process.stderr.write(`[fatal] application failed to start: ${detail}\n`);
  const logger = createLogger('bootstrap');
  logger.error('application failed to start', { error: detail });
  process.exitCode = 1;
});
