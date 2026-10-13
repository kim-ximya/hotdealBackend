import { resolve } from 'node:path';
import { ArticleStore } from './src/article-store.js';
import { SeleniumCollector } from './src/selenium-collector.js';
import { CrawlService, loadInterval } from './src/crawl-service.js';
import { CrawlerApi } from './src/crawler-api.js';
import { readServerConfig } from './src/server-config.js';

const log = (message) => console.log(`[${new Date().toISOString()}] ${message}`);
let service;
let api;
let stopping;

async function shutdown() {
  if (!stopping) {
    stopping = (async () => {
      log('수집 서버와 전용 브라우저를 종료합니다.');
      const results = await Promise.allSettled([service?.stop(), api?.stop()]);
      const failed = results.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
    })();
  }
  return stopping;
}

try {
  try { process.loadEnvFile(resolve(import.meta.dirname, '.env')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const config = readServerConfig(process.env, import.meta.dirname);
  const store = new ArticleStore({ path: resolve(config.directory, 'articles.json'), maxArticles: config.maxArticles });
  await store.load();
  const settingsPath = resolve(config.directory, 'settings.json');
  const intervalSeconds = await loadInterval(settingsPath, config.intervalOverride);
  const source = new SeleniumCollector({ directory: config.directory, waitSeconds: config.waitSeconds, chromeBinary: config.chromeBinary });
  service = new CrawlService({ source, store, intervalSeconds, settingsPath });
  service.on('collectionStarted', () => log('핫딜 목록 수집을 시작합니다.'));
  service.on('collected', ({ collectedCount, addedCount, storedCount }) => {
    log(`수집·저장 완료: 이번 목록 ${collectedCount}개, 새 글 ${addedCount}개, 총 보관 ${storedCount}개`);
  });
  service.on('collectionFailed', ({ message }) => log(`수집 실패: ${message} 마지막으로 저장한 데이터를 유지합니다.`));
  service.on('intervalChanged', ({ intervalSeconds: seconds }) => log(`수집 간격 변경: ${seconds}초`));
  api = new CrawlerApi({ service, store, port: config.port, allowedOrigins: config.allowedOrigins });
  await api.start();
  const onSignal = () => { void shutdown().catch((error) => { console.error(error.message); process.exitCode = 1; }); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  log(`Selenium 핫딜 수집 서버: ${api.baseUrl}`);
  log(`수집 간격: ${intervalSeconds}초 / JSON 저장: ${store.path}`);
  log(`게시글: ${api.baseUrl}/api/articles / 상태: ${api.baseUrl}/api/status`);
  log('전용 Chrome 창을 유지합니다. 보안 확인이 나타나면 해당 창에서 직접 완료하세요.');
  service.start();
} catch (error) {
  console.error(`서버 시작 실패: ${error.message}`);
  await shutdown().catch((shutdownError) => console.error(shutdownError.message));
  process.exitCode = 1;
}
