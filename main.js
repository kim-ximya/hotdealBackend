import { resolve } from 'node:path';
import { createServerRuntime } from './src/server-runtime.js';
import { readServerConfig } from './src/server-config.js';

let runtime;
const log = (level, message) => console[level === 'error' ? 'error' : 'log'](`[${new Date().toISOString()}] ${message}`);
try {
  try { process.loadEnvFile(resolve(import.meta.dirname, '.env')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  runtime = await createServerRuntime(readServerConfig(process.env, import.meta.dirname), { log });
  const onSignal = () => { void runtime.stop().catch((error) => { log('error', error.message); process.exitCode = 1; }); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  await runtime.start();
} catch (error) {
  log('error', `서버 시작 실패: ${error.message}`);
  await runtime?.stop().catch((stopError) => log('error', stopError.message));
  process.exitCode = 1;
}
