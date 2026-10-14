const path = require('node:path');
const { existsSync } = require('node:fs');

// Electron's Windows readback exposes positional arguments, not switches.
const STARTUP_ARGUMENT = 'hotdeal-windows-startup';
const STARTUP_NAME = '핫딜 수집 관리자';
const isStartupLaunch = (argv) => argv.includes(STARTUP_ARGUMENT);

class WindowsStartup {
  constructor({ app, root, execPath = process.execPath, platform = process.platform, exists = existsSync }) {
    this.app = app;
    this.platform = platform;
    this.exists = exists;
    this.entry = app.isPackaged ? null : path.win32.join(root, 'desktop', 'main.cjs');
    // The node_modules link is stable across pnpm's versioned Electron paths.
    this.options = {
      path: app.isPackaged ? execPath : path.win32.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
      // Pass the path as one argument; Electron quotes it in the Run command.
      args: this.entry ? [this.entry, STARTUP_ARGUMENT] : [STARTUP_ARGUMENT],
    };
  }

  read() {
    if (this.platform !== 'win32') return { supported: false, registered: false, enabled: false, disabledByWindows: false };
    const state = this.app.getLoginItemSettings(this.options);
    const ownItem = state.launchItems?.find((item) => item.name === STARTUP_NAME && item.scope === 'user');
    // openAtLogin can refer to the default app ID when a custom registry name is
    // used. Verify this entry's command and approval instead of another app ID.
    const matchesPath = ownItem && path.win32.normalize(ownItem.path).toLowerCase() === path.win32.normalize(this.options.path).toLowerCase();
    const matchesArgs = ownItem?.args?.length === this.options.args.length && ownItem.args.every((arg, index) =>
      typeof arg === 'string' && (this.entry && index === 0
        ? path.win32.normalize(arg).toLowerCase() === path.win32.normalize(this.options.args[index]).toLowerCase()
        : arg === this.options.args[index]));
    const registered = Boolean(matchesPath && matchesArgs);
    return { supported: true, registered, enabled: registered && ownItem.enabled === true,
      disabledByWindows: registered && ownItem.enabled !== true };
  }

  set(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('자동 실행 설정은 켜기 또는 끄기로 지정하세요.');
    if (this.platform !== 'win32') throw new Error('Windows에서만 자동 실행을 설정할 수 있습니다.');
    if (enabled && (!this.exists(this.options.path) || (this.entry && !this.exists(this.entry)))) {
      throw new Error('자동 실행에 필요한 앱 파일을 찾지 못했습니다. 프로젝트 위치와 Electron 설치를 확인하세요.');
    }
    this.app.setLoginItemSettings({ ...this.options, name: STARTUP_NAME, openAtLogin: enabled, enabled });
    const status = this.read();
    if ((enabled && !status.enabled) || (!enabled && status.registered)) throw new Error('Windows 자동 실행 설정을 적용하지 못했습니다.');
    return status;
  }
}

module.exports = { WindowsStartup, STARTUP_ARGUMENT, STARTUP_NAME, isStartupLaunch };
