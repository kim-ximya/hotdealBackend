import { readFile } from 'node:fs/promises';
import { atomicWriteJson } from '../src/article-store.js';

export const defaultNotificationSettings = () => ({ enabled: true, soundEnabled: true });

export function validateNotificationSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !['enabled', 'soundEnabled'].includes(key)) ||
      typeof value.enabled !== 'boolean' || typeof value.soundEnabled !== 'boolean') {
    throw new Error('알림과 소리 설정은 켜기 또는 끄기로 지정하세요.');
  }
  return { enabled: value.enabled, soundEnabled: value.soundEnabled };
}

export async function loadNotificationSettings(path) {
  try { return validateNotificationSettings(JSON.parse(await readFile(path, 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return defaultNotificationSettings(); throw error; }
}

export async function saveNotificationSettings(path, value) {
  const settings = validateNotificationSettings(value);
  await atomicWriteJson(path, settings);
  return settings;
}
