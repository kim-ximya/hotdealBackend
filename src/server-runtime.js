import { resolve } from 'node:path';
import { ArticleStore } from './article-store.js';
import { SeleniumCollector } from './selenium-collector.js';
import { CrawlService, loadInterval } from './crawl-service.js';
import { CrawlerApi } from './crawler-api.js';

export async function createServerRuntime(config, { log = () => {}, source: providedSource } = {}) {
  const store = new ArticleStore({ path: resolve(config.directory, 'articles.json'), maxArticles: config.maxArticles });
  await store.load();
  const settingsPath = resolve(config.directory, 'settings.json');
  const intervalSeconds = await loadInterval(settingsPath, config.intervalOverride);
  const source = providedSource || new SeleniumCollector({ directory: config.directory, waitSeconds: config.waitSeconds, chromeBinary: config.chromeBinary });
  const service = new CrawlService({ source, store, intervalSeconds, settingsPath });
  const api = new CrawlerApi({ service, store, port: config.port, allowedOrigins: config.allowedOrigins });
  let starting = null;
  let stopping = null;
  service.on('collectionStarted', () => log('info', '핫딜 목록 수집을 시작합니다.'));
  service.on('collected', ({ collectedCount, addedCount, storedCount }) => {
    log('info', `수집·저장 완료: 이번 목록 ${collectedCount}개, 새 글 ${addedCount}개, 총 보관 ${storedCount}개`);
  });
  service.on('collectionFailed', ({ message }) => log('error', `수집 실패: ${message} 마지막으로 저장한 데이터를 유지합니다.`));
  service.on('intervalChanged', ({ intervalSeconds: seconds }) => log('info', `수집 간격 변경: ${seconds}초`));
  return {
    service, api, store, config,
    start() {
      if (stopping) return Promise.resolve();
      if (!starting) starting = (async () => {
        await api.start();
        if (stopping) return;
        log('info', `Selenium 핫딜 수집 서버: ${api.baseUrl}`);
        log('info', `수집 간격: ${intervalSeconds}초 / JSON 저장: ${store.path}`);
        log('info', '전용 Chrome 창을 유지합니다. 보안 확인이 나타나면 해당 창에서 직접 완료하세요.');
        service.start();
      })();
      return starting;
    },
    stop() {
      if (!stopping) stopping = (async () => {
        log('info', '수집 서버와 전용 브라우저를 종료합니다.');
        await starting?.catch(() => {});
        const results = await Promise.allSettled([service.stop(), api.stop()]);
        const failure = results.find((result) => result.status === 'rejected');
        if (failure) throw failure.reason;
      })();
      return stopping;
    },
  };
}
