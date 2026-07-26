import { BotApplication } from './app';
import { DEFAULT_CONFIG_PATH, loadAppConfigFile } from './config-store';
import { createLogger } from './logger';

async function main(): Promise<void> {
  const logger = createLogger('bootstrap');
  const config = await loadAppConfigFile(DEFAULT_CONFIG_PATH);
  logger.info('config loaded', {
    filePath: DEFAULT_CONFIG_PATH,
    dataDir: config.settings.dataDir,
  });

  const app = new BotApplication(config.settings, DEFAULT_CONFIG_PATH);

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
  const logger = createLogger('bootstrap');
  logger.error('application failed to start', {
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  });
  process.exitCode = 1;
});
