import { join } from 'node:path';
import { BrowserRelay, loadRelayToken } from './src/browser-relay.js';

const log = (message) => console.log(`[${new Date().toISOString()}] ${message}`);

try {
  const token = await loadRelayToken(join(import.meta.dirname, '.local', 'relay-token'));
  const relay = new BrowserRelay({ token, port: Number(process.env.PORT || 38471) });

  relay.on('newArticle', (event) => {
    log(`새 글 알림(na) 수신: ${JSON.stringify(event)}`);
  });
  relay.on('articlesUpdated', ({ total, trigger }) => {
    log(`핫딜 목록 갱신 완료: ${total}개 (계기: ${trigger})`);
  });
  relay.on('collectionError', ({ message, httpStatus }) => {
    log(`핫딜 목록 수집 실패: ${message}${httpStatus ? ` (HTTP ${httpStatus})` : ''}`);
  });
  relay.on('browserEvent', ({ type, socketState }) => {
    const descriptions = {
      ready: '브라우저 스크립트 연결 완료',
      subscribed: '브라우저의 핫딜 WebSocket 구독 감지',
      disconnected: '브라우저의 WebSocket 연결 종료',
      socketError: '브라우저의 WebSocket 오류',
    };
    if (descriptions[type]) log(`${descriptions[type]} (상태: ${socketState})`);
  });

  await relay.start();
  log(`브라우저 중계 백엔드 실행: ${relay.baseUrl}`);
  log(`유저스크립트 설치: ${relay.baseUrl}/hotdeal-relay.user.js`);
  log(`상태 확인: ${relay.baseUrl}/api/status`);
  log(`게시글 목록 API: ${relay.baseUrl}/api/articles`);

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    log('백엔드를 종료합니다.');
    await relay.stop();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch (error) {
  console.error(`백엔드 시작 실패: ${error.message}`);
  process.exitCode = 1;
}
