import { createServerRuntime } from '../src/server-runtime.js';

let runtime;
let timer;
let closing = false;
let initializing = null;
const send = (message) => process.parentPort.postMessage(message);
const status = () => { if (runtime) send({ type: 'status', status: runtime.service.getStatus() }); };

process.parentPort.on('message', async ({ data: message }) => {
  if (message.type !== 'command') return;
  const reply = (result, error) => send({ type: 'response', requestId: message.requestId, result, error });
  try {
    if (message.action === 'initialize') {
      if (initializing || closing) throw new Error('이미 초기화 중이거나 종료 중입니다.');
      initializing = (async () => {
        runtime = await createServerRuntime(message.config, { log: (level, text) => send({ type: 'log', level, message: text }) });
        runtime.service.on('collected', ({ articles }) => {
          if (!closing) send({ type: 'articles-collected', articles });
        });
        if (closing) return;
        await runtime.start();
        if (closing) return;
        send({ type: 'ready', baseUrl: runtime.api.baseUrl, status: runtime.service.getStatus() });
        timer = setInterval(status, 1000);
      })();
      await initializing;
      reply({ ready: true });
    } else if (message.action === 'shutdown') {
      closing = true;
      clearInterval(timer);
      await initializing?.catch(() => {});
      await runtime?.stop();
      reply({ stopped: true });
      process.exit(0);
    } else {
      if (!runtime || closing) throw new Error('서버가 실행 중이 아닙니다.');
      if (message.action === 'interval') reply(await runtime.service.setIntervalSeconds(message.value));
      else if (message.action === 'collect') { void runtime.service.collectNow(); reply({ accepted: true }); }
      else throw new Error('알 수 없는 명령입니다.');
      status();
    }
  } catch (error) {
    reply(undefined, error.message);
    send({ type: 'log', level: 'error', message: error.message });
    // Keep the process available for explicit shutdown if initialization failed.
  }
});
