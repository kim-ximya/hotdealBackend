import { resolve } from 'node:path';

export function readServerConfig(env, rootDirectory) {
  const integer = (name, fallback, min, max) => {
    const raw = env[name] ?? String(fallback);
    const number = Number(raw);
    if (String(raw).trim() === '' || !Number.isInteger(number) || number < min || number > max) {
      throw new Error(`${name}는 ${min}~${max} 사이의 정수여야 합니다.`);
    }
    return number;
  };
  return {
    port: integer('PORT', 38471, 0, 65535),
    directory: resolve(rootDirectory, env.DATA_DIR || '.local/selenium-server'),
    maxArticles: integer('MAX_ARTICLES', 10000, 1, 100000),
    waitSeconds: integer('SELENIUM_WAIT_SECONDS', 120, 1, 600),
    intervalOverride: env.CRAWL_INTERVAL_SECONDS,
    chromeBinary: env.SELENIUM_CHROME_BINARY || undefined,
    allowedOrigins: (env.FRONTEND_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean),
  };
}
