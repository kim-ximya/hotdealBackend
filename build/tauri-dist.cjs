const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
process.chdir(root);
require('./prepare-tauri.cjs');
const signing = process.env.TAURI_SIGNING_PRIVATE_KEY?.trim();
const cli = path.join(root, 'node_modules/@tauri-apps/cli/tauri.js');
const options = ['build', '--target', 'x86_64-pc-windows-msvc', '--bundles', 'nsis'];
if (signing) {
  const config = path.join(root, '.local', 'tauri-release-config.json');
  fs.writeFileSync(config, JSON.stringify({
    bundle: { createUpdaterArtifacts: true },
  }));
  options.push('--config', config);
}
options.push('--', '--locked');
const result = spawnSync(process.execPath, [cli, ...options], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
