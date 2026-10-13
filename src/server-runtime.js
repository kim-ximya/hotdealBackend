import { resolve } from 'node:path';
import { ArticleStore } from './article-store.js';
import { SeleniumCollector } from './selenium-collector.js';
import { CrawlService, loadInterval } from './crawl-service.js';
import { CrawlerApi } from './crawler-api.js';
import { loadUserAgent } from './browser-settings.js';

export async function createServerRuntime(config, { log = () => {}, source: providedSource } = {}) {
  const store = new ArticleStore({ path: resolve(config.directory, 'articles.json'), maxArticles: config.maxArticles });
  await store.load();
  const settingsPath = resolve(config.directory, 'settings.json');
  const intervalSeconds = await loadInterval(settingsPath, config.intervalOverride);
  const userAgent = await loadUserAgent(resolve(config.directory, 'browser-settings.json'), config.userAgentOverride);
  const source = providedSource || new SeleniumCollector({ directory: config.directory, waitSeconds: config.waitSeconds, chromeBinary: config.chromeBinary, userAgent });
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
    service, api, store, config: { ...config, userAgent },
    start() {
      if (stopping) return Promise.resolve();
      if (!starting) starting = (async () => {
        await api.start();
        if (stopping) return;
        log('info', `Selenium 핫딜 수집 서버: ${api.baseUrl}`);
        log('info', `수집 간격: ${intervalSeconds}초 / JSON 저장: ${store.path}`);
        log('info', `User-Agent: ${userAgent ? '사용자 지정' : 'Chrome 기본값'}`);
        log('info', 'Chrome 헤드리스 모드로 백그라운드 수집합니다. 보안 확인으로 수집에 실패하면 마지막 저장 데이터를 유지합니다.');
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
