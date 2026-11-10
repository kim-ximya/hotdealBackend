const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const desktop = path.join(root, 'desktop');
const frontend = path.join(root, '.local', 'tauri-frontend');
const resources = path.join(root, 'src-tauri', 'resources');
const selenium = path.dirname(require.resolve('selenium-webdriver/package.json'));
const files = [
  'index.html', 'styles.css', 'renderer.js', 'article-list.js', 'interest-view.js', 'update-view.js',
  'logs.html', 'logs.css', 'logs.js', 'notification.html', 'notification.css', 'notification.js',
  'notification-drag.js', 'tauri-bridge.js', 'assets/notification.wav',
];
fs.mkdirSync(path.join(frontend, 'assets'), { recursive: true });
fs.mkdirSync(resources, { recursive: true });
for (const entry of fs.readdirSync(frontend, { recursive: true, withFileTypes: true })) {
  const name = path.relative(frontend, path.join(entry.parentPath, entry.name)).replaceAll('\\', '/');
  if ((entry.isDirectory() && name === 'assets') || (entry.isFile() && files.includes(name))) continue;
  throw new Error('번들 폴더에 배포 대상이 아닌 파일이 있습니다: ' + name);
}
for (const file of files) fs.copyFileSync(path.join(desktop, file), path.join(frontend, file));
fs.copyFileSync(path.join(selenium, 'bin/windows/selenium-manager.exe'), path.join(resources, 'selenium-manager.exe'));
const notices = ['LICENSE', 'NOTICE', 'bin/selenium-manager-THIRD-PARTY-NOTICES.txt']
  .map((file) => fs.readFileSync(path.join(selenium, file), 'utf8')).join('\n\n');
fs.writeFileSync(path.join(resources, 'SELENIUM-NOTICES.txt'), notices);
