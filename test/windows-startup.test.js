import test from 'node:test';
import assert from 'node:assert/strict';
import startupModule from '../desktop/windows-startup.cjs';

const { WindowsStartup, STARTUP_ARGUMENT, STARTUP_NAME, isStartupLaunch } = startupModule;

function fixture(options = {}) {
  const { app: overrides, ...configuration } = options;
  let registered = false;
  let approved = true;
  const writes = [];
  const reads = [];
  const app = {
    isPackaged: false,
    getLoginItemSettings(query) {
      reads.push(query);
      return { openAtLogin: registered, launchItems: registered ? [{ ...query, name: STARTUP_NAME, scope: 'user', enabled: approved }] : [] };
    },
    setLoginItemSettings(value) { writes.push(value); registered = value.openAtLogin; approved = value.enabled; },
    ...overrides,
  };
  const startup = new WindowsStartup({ app, root: 'C:\\Demo User\\핫딜 앱', platform: 'win32', exists: () => true, ...configuration });
  return { startup, writes, reads, block: () => { approved = false; } };
}

test('development startup passes the absolute entry as one argument and uses the stable Electron path for registration and readback', () => {
  const { startup, reads, writes } = fixture();
  assert.equal(startup.read().enabled, false);
  assert.equal(startup.set(true).enabled, true);
  assert.deepEqual(writes[0], {
    path: 'C:\\Demo User\\핫딜 앱\\node_modules\\electron\\dist\\electron.exe',
    args: ['C:\\Demo User\\핫딜 앱\\desktop\\main.cjs', STARTUP_ARGUMENT],
    name: STARTUP_NAME, openAtLogin: true, enabled: true,
  });
  assert.deepEqual(reads.at(-1), startup.options);
  assert.equal(startup.set(false).registered, false);
  assert.equal(writes[1].name, STARTUP_NAME);
});

test('Windows disabled status is distinguished from an unregistered app and can be enabled again', () => {
  const { startup, block } = fixture();
  startup.set(true); block();
  assert.deepEqual(startup.read(), { supported: true, registered: true, enabled: false, disabledByWindows: true });
  assert.equal(startup.set(true).enabled, true);
});

test('unrelated or machine-wide launch items cannot be reported as this user app being enabled', () => {
  for (const item of [{ name: 'OtherElectronApp', scope: 'user', enabled: true }, { name: STARTUP_NAME, scope: 'machine', enabled: true }]) {
    const { startup } = fixture({ app: { getLoginItemSettings: () => ({ openAtLogin: true, launchItems: [item] }) } });
    assert.equal(startup.read().enabled, false);
  }
});

test('custom-name registration is verified from its command even if the default app ID reports openAtLogin false', () => {
  const { startup } = fixture({ app: {
    getLoginItemSettings: (query) => ({ openAtLogin: false, launchItems: [{ ...query, name: STARTUP_NAME, scope: 'user', enabled: true }] }),
  } });
  assert.equal(startup.read().enabled, true);
});

test('invalid input or missing launch files cannot create a startup entry, while removal still works', () => {
  const { startup, writes } = fixture({ exists: () => false });
  assert.throws(() => startup.set(true), /앱 파일/);
  for (const value of [null, 'true', 1, {}]) assert.throws(() => startup.set(value), /설정/);
  assert.equal(writes.length, 0);
  assert.equal(startup.set(false).enabled, false);
  assert.equal(writes.length, 1);
});

test('packaged app uses its own executable; unsupported platforms never alter startup settings', () => {
  const { startup } = fixture({ app: { isPackaged: true }, execPath: 'C:\\App\\Hotdeal.exe' });
  assert.deepEqual(startup.options, { path: 'C:\\App\\Hotdeal.exe', args: [STARTUP_ARGUMENT] });
  const unsupported = fixture({ platform: 'linux' });
  assert.equal(unsupported.startup.read().supported, false);
  assert.throws(() => unsupported.startup.set(true), /Windows/);
  assert.equal(unsupported.writes.length, 0);
});

test('registration errors are surfaced instead of reporting success', () => {
  const { startup } = fixture({ app: { setLoginItemSettings: () => {} } });
  assert.throws(() => startup.set(true), /적용하지 못/);
});

test('only the exact login flag selects hidden automatic startup; manual and unrelated arguments do not', () => {
  assert.equal(isStartupLaunch(['electron.exe', 'desktop/main.cjs', STARTUP_ARGUMENT]), true);
  assert.equal(isStartupLaunch(['electron.exe', 'desktop/main.cjs']), false);
  assert.equal(isStartupLaunch(['electron.exe', `${STARTUP_ARGUMENT}=false`]), false);
});
