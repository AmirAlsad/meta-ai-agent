import 'dotenv/config';
import pino from 'pino';
import { loadConfig } from './config/loader.js';
import { createApp } from './http/app.js';

function main(): void {
  const config = loadConfig();
  const logger = pino({
    level: process.env.LOG_LEVEL ?? 'info',
    transport:
      config.nodeEnv === 'production'
        ? undefined
        : {
            target: 'pino-pretty',
            options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' }
          }
  });

  const app = createApp({ config, logger });

  const shouldStart = config.agentAutostart && config.nodeEnv !== 'test';
  if (!shouldStart) {
    logger.info(
      { agentAutostart: config.agentAutostart, nodeEnv: config.nodeEnv },
      'autostart skipped'
    );
    return;
  }

  const server = app.listen(config.port, () => {
    logger.info(
      {
        port: config.port,
        channels: config.channels,
        publicBaseUrl: config.publicBaseUrl ?? null
      },
      'meta-ai-agent listening'
    );
  });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
