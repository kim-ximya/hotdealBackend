const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const builderRequire = createRequire(require.resolve('electron-builder/package.json'));
const libraryRequire = createRequire(builderRequire.resolve('app-builder-lib/package.json'));
const asar = libraryRequire('@electron/asar');

module.exports = async ({ appOutDir }) => {
  const resources = path.join(appOutDir, 'resources');
  const archive = path.join(resources, 'app.asar');
  const files = asar.listPackage(archive).map((file) => file.replaceAll('\\', '/'));
  const allowed = new Set(['desktop', 'src', 'node_modules', 'package.json']);
  for (const file of files) {
    if (!allowed.has(file.split('/')[1])) throw new Error(`배포 대상이 아닌 파일: ${file}`);
    if (/(^|\/)\.env(?:\.|$)|(^|\/)\.local(?:\/|$)/.test(file)) throw new Error(`개인 설정이 포함되었습니다: ${file}`);
  }
  const manager = path.join(resources, 'app.asar.unpacked', 'node_modules', 'selenium-webdriver', 'bin', 'windows', 'selenium-manager.exe');
  if (!fs.existsSync(manager)) throw new Error('Selenium Manager 실행 파일이 ASAR 밖에 없습니다.');
  for (const required of ['/desktop/server-worker.js', '/desktop/app-updates.cjs', '/desktop/update-view.js', '/desktop/logs.html',
    '/node_modules/electron-updater/out/main.js', '/node_modules/selenium-webdriver/NOTICE', '/node_modules/selenium-webdriver/LICENSE',
    '/node_modules/selenium-webdriver/bin/selenium-manager-THIRD-PARTY-NOTICES.txt']) {
    if (!files.includes(required)) throw new Error(`배포 필수 파일 누락: ${required}`);
  }
  const notices = ['Third-party software notices\n\nElectron/Chromium notices are included as LICENSE.electron.txt and LICENSES.chromium.html beside the application.\n'];
  for (const file of files.filter((file) => /^\/node_modules\/.+\/(?:LICENSE(?:\..*)?|NOTICE(?:\..*)?|COPYING(?:\..*)?|.*THIRD-PARTY-NOTICES\.txt)$/i.test(file))) {
    notices.push(`\n===== ${file} =====\n${asar.extractFile(archive, path.normalize(file.slice(1))).toString('utf8')}`);
  }
  fs.writeFileSync(path.join(resources, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n'), 'utf8');
  console.log('배포 검사 통과: 실행 파일, 의존성 고지, 개인 데이터 제외');
};
