import 'dotenv/config';
import { resolveConfig } from './server/config.js';
import { initLogger } from './server/logger.js';
import { createAndStartServer } from './server/server.js';

const config = resolveConfig();
initLogger(config.logFormat, config.logLevel);

createAndStartServer(config).catch((err: unknown) => {
  process.stderr.write(`Fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
