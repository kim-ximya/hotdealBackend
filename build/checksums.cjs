const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const { version } = require('../package.json');
const directory = path.resolve(__dirname, '../release');
const installers = fs.readdirSync(directory).filter((name) => name.startsWith(`HotdealCollector-Setup-${version}-`) && name.endsWith('.exe'));
if (!installers.length) throw new Error('생성된 설치 파일이 없습니다.');
const lines = installers.map((name) => `${createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex')}  ${name}`);
fs.writeFileSync(path.join(directory, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`);
fs.copyFileSync(path.resolve(__dirname, '../docs/release-1.0.md'), path.join(directory, '사용 안내.md'));
console.log(lines.join('\n'));
