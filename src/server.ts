import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildApp } from './app.js';
import { readConfig } from './config.js';

const config = readConfig();
const app = buildApp({ ...config, logger: true });
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await app.close();
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown().catch((error: unknown) => {
      app.log.error({ err: error }, 'Shutdown failed');
      process.exitCode = 1;
    });
  });
}

try {
  await promisify(execFile)('ffmpeg', ['-version'], { timeout: 5_000 });
  await app.listen({ host: '0.0.0.0', port: config.port });
} catch (error) {
  app.log.error({ err: error }, 'Unable to start audio converter');
  process.exitCode = 1;
  await shutdown();
}
