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

  const shutdown = async (): Promise<void> => {
    try {
      await app.stop();
    } catch (error) {
      logger.error('failed to stop application', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  process.once('SIGINT', () => {
    void shutdown().finally(() => process.exit(0));
  });

  process.once('SIGTERM', () => {
    void shutdown().finally(() => process.exit(0));
  });

  await app.start();
}

void main().catch((error) => {
  const logger = createLogger('bootstrap');
  logger.error('application failed to start', {
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  });
  process.exitCode = 1;
});
