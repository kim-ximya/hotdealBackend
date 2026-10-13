const { app, BrowserWindow, ipcMain, utilityProcess, shell, Menu, dialog, Tray } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { mkdir } = require('node:fs/promises');

let window;
let controller;
let tray;
let trayStatus;
let quitting = false;
let quitPending = false;
const root = path.resolve(__dirname, '..');
const page = pathToFileURL(path.join(__dirname, 'index.html')).href;
const icon = path.join(__dirname, 'assets', 'hotdeal.ico');

function showWindow() {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function hideToTray() {
  if (quitting || quitPending) return;
  if (!tray || tray.isDestroyed()) throw new Error('트레이 아이콘을 사용할 수 없습니다.');
  if (window && !window.isDestroyed()) window.hide();
}

function updateTray(snapshot) {
  const status = quitPending ? '앱 종료 중' : {
    stopped: '서버 중지', starting: '서버 시작 중', stopping: '서버 종료 중',
    running: snapshot.owned ? '서버 실행 중' : '외부 서버 연결', error: '오류 확인 필요',
  }[snapshot.phase] || '준비 중';
  if (!tray || tray.isDestroyed() || status === trayStatus) return;
  trayStatus = status;
  tray.setToolTip(`핫딜 수집 관리자 · ${status}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '핫딜 수집 관리자', enabled: false },
    { label: status, enabled: false },
    { type: 'separator' },
    { label: '창 열기', click: showWindow },
    { type: 'separator' },
    { label: '앱 완전 종료', enabled: !quitPending, click: () => app.quit() },
  ]));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.setPath('userData', path.join(root, '.local', 'desktop'));
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  app.whenReady().then(async () => {
    try { process.loadEnvFile(path.join(root, '.env')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const { readServerConfig } = await import('../src/server-config.js');
    const { ServerController } = await import('./server-controller.js');
    const config = readServerConfig({ ...process.env, SELENIUM_USER_AGENT: undefined }, root);
    controller = new ServerController({ config,
      spawnWorker: () => utilityProcess.fork(path.join(__dirname, 'server-worker.js'), [], {
        cwd: root, stdio: 'pipe', serviceName: 'Hotdeal Selenium Server',
      }),
    });
    await controller.initialize();
    Menu.setApplicationMenu(null);
    window = new BrowserWindow({ width: 1160, height: 960, minWidth: 940, minHeight: 740,
      title: '핫딜 수집 관리자', icon, backgroundColor: '#0c111b', show: false,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    tray = new Tray(icon);
    tray.on('click', showWindow);
    tray.on('double-click', showWindow);
    updateTray(controller.snapshot());
    window.on('close', (event) => {
      if (quitting) return;
      event.preventDefault();
      hideToTray();
    });
    window.on('minimize', () => hideToTray());
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    const actions = {
      snapshot: () => controller.snapshot(), start: () => controller.start(), stop: () => controller.stop(),
      interval: (value) => controller.setIntervalSeconds(value), collect: () => controller.collectNow(),
      userAgent: (value) => controller.setUserAgent(value),
      articles: (query) => controller.getArticles(query),
      hideToTray,
      openArticle: (id) => {
        if (typeof id !== 'string' || !/^\d{1,30}$/.test(id)) throw new Error('게시글 ID가 올바르지 않습니다.');
        return shell.openExternal(`https://arca.live/b/hotdeal/${id}`);
      },
      clearLogs: () => { controller.clearLogs(); return controller.snapshot(); },
      openData: async () => { await mkdir(config.directory, { recursive: true }); const error = await shell.openPath(config.directory); if (error) throw new Error(error); },
    };
    for (const [name, action] of Object.entries(actions)) ipcMain.handle(`hotdeal:${name}`, async (event, value) => {
      if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== page) throw new Error('허용되지 않은 요청입니다.');
      try { return { ok: true, value: await action(value) }; }
      catch (error) { return { ok: false, error: error.message }; }
    });
    controller.on('snapshot', (snapshot) => {
      updateTray(snapshot);
      if (window && !window.isDestroyed()) window.webContents.send('hotdeal:snapshot', snapshot);
    });
    window.once('ready-to-show', () => window.show());
    await window.loadFile(path.join(__dirname, 'index.html'));
  }).catch((error) => { dialog.showErrorBox('핫딜 관리자 시작 오류', error.message); quitting = true; app.quit(); });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (quitting || !controller) return;
    event.preventDefault();
    if (quitPending) return;
    quitPending = true;
    updateTray(controller.snapshot());
    controller.stop().then(() => { quitting = true; app.quit(); }).catch((error) => {
      quitPending = false;
      updateTray(controller.snapshot());
      showWindow();
      dialog.showErrorBox('서버 종료 대기', `서버 종료를 완료하지 못했습니다. 앱에서 상태를 확인하고 다시 중지하세요.\n${error.message}`);
    });
  });
  app.on('will-quit', () => { if (tray && !tray.isDestroyed()) tray.destroy(); });
}
