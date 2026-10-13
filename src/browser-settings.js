import { readFile } from 'node:fs/promises';

export function normalizeUserAgent(value) {
  if (typeof value !== 'string' || value.length > 1024 || /[^\x20-\x7e]/.test(value)) {
    throw new Error('User-Agent는 개행 없이 영문·숫자·기호로 된 1024자 이하의 문자열이어야 합니다.');
  }
  return value.trim();
}

export async function loadUserAgent(path, override) {
  if (override !== undefined) return normalizeUserAgent(override);
  try {
    const settings = JSON.parse(await readFile(path, 'utf8'));
    return normalizeUserAgent(settings?.userAgent);
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw new Error(`브라우저 설정을 읽지 못했습니다. 기존 파일을 보존합니다: ${error.message}`);
  }
}
