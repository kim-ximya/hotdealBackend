const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
process.chdir(root);
require('./prepare-tauri.cjs');
const key = process.env.TAURI_UPDATER_PUBLIC_KEY?.trim();
const signing = process.env.TAURI_SIGNING_PRIVATE_KEY?.trim();
if (!!key !== !!signing) throw new Error('서명 빌드에는 공개키와 서명 개인키가 모두 필요합니다.');
const cli = path.join(root, 'node_modules/@tauri-apps/cli/tauri.js');
const options = ['build', '--target', 'x86_64-pc-windows-msvc', '--bundles', 'nsis'];
if (key) {
  const config = path.join(root, '.local', 'tauri-release-config.json');
  fs.writeFileSync(config, JSON.stringify({
    bundle: { createUpdaterArtifacts: true },
    plugins: { updater: {
      pubkey: key,
      endpoints: ['https://github.com/kim-ximya/hotdealBackend/releases/latest/download/latest.json'],
      requireSignedVersion: true,
      windows: { installMode: 'passive' },
    } },
  }));
  options.push('--config', config);
}
options.push('--', '--locked');
const result = spawnSync(process.execPath, [cli, ...options], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
