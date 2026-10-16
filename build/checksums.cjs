const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');

const { version } = require('../package.json');
const directory = path.resolve(__dirname, '../release');
const installers = fs.readdirSync(directory).filter((name) => name.startsWith(`HotdealCollector-Setup-${version}-`) && name.endsWith('.exe'));
if (!installers.length) throw new Error('생성된 설치 파일이 없습니다.');
const updaterRequire = createRequire(require.resolve('electron-updater/package.json'));
const yaml = updaterRequire('js-yaml');
const info = yaml.load(fs.readFileSync(path.join(directory, 'latest.yml'), 'utf8'));
if (info.version !== version || info.files?.length !== installers.length) throw new Error('업데이트 메타데이터 버전 또는 파일 수가 다릅니다.');
for (const name of installers) {
  const entry = info.files.find(({ url }) => url === name);
  const data = fs.readFileSync(path.join(directory, name));
  if (!entry || entry.size !== data.length || entry.sha512 !== createHash('sha512').update(data).digest('base64')) {
    throw new Error('업데이트 설치 파일의 크기 또는 SHA-512가 다릅니다.');
  }
  if (!fs.existsSync(path.join(directory, `${name}.blockmap`))) throw new Error('업데이트 blockmap 파일이 없습니다.');
}
const feed = yaml.load(fs.readFileSync(path.join(directory, 'win-unpacked/resources/app-update.yml'), 'utf8'));
if (feed.provider !== 'github' || feed.owner !== 'kim-ximya' || feed.repo !== 'hotdealBackend' || feed.private || feed.token) {
  throw new Error('공개 GitHub 업데이트 설정이 올바르지 않습니다.');
}
const assets = [...installers, ...installers.map((name) => `${name}.blockmap`), 'latest.yml'];
const lines = assets.map((name) => `${createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex')}  ${name}`);
fs.writeFileSync(path.join(directory, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`);
fs.copyFileSync(path.resolve(__dirname, '../docs/release-1.1.md'), path.join(directory, '사용 안내.md'));
console.log(lines.join('\n'));
