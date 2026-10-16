import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeKeywords, createInterestMatcher, selectArticles } from '../src/interests.js';
import { InterestSettings } from '../desktop/interest-settings.js';

test('interests match literal title substrings with Unicode, case and whitespace normalization, using OR', () => {
  const match = createInterestMatcher(['ＳＳＤ', '생수', 'RTX  5080', '[쿠폰]', 'c++']);
  assert.ok(match({ title: '특가 ssd 2TB' }));
  assert.ok(match({ title: '생수 2L' }));
  assert.ok(match({ title: 'RTX\n5080 그래픽카드' }));
  assert.ok(match({ title: '[쿠폰] 행사' }));
  assert.ok(match({ title: 'C++ 게임' }));
  assert.equal(match({ title: '일반 상품', author: 'SSD', category: '생수' }), false);
  assert.equal(match({ title: '쿠폰 행사' }), false);
  assert.equal(match({}), false);
  assert.equal(createInterestMatcher([])({ title: '생수' }), false);
  assert.ok(createInterestMatcher(['가전'])({ title: '가전 세일'.normalize('NFD') }));
});

test('interests normalize duplicates and reject malformed or excessive keywords', () => {
  assert.deepEqual(normalizeKeywords(['  SSD ', 'ｓｓｄ', '생수', 'RTX  5080']), ['SSD', '생수', 'RTX 5080']);
  for (const value of [null, 'SSD', [''], ['  '], [1], ['x\ny'], ['x\u0000'], ['a'.repeat(81)], Array(101).fill('x')]) {
    assert.throws(() => normalizeKeywords(value));
  }
});

test('filtering covers the full snapshot before pagination, without changing stored posts or total count', () => {
  const snapshot = { total: 140, updatedAt: '2026-10-16T00:00:00Z', articles: Array.from({ length: 140 }, (_, i) => ({ id: String(140 - i), title: i % 2 ? '생수' : 'SSD' })) };
  const page = selectArticles(snapshot, { keywords: ['ssd'], offset: 50, limit: 50 });
  assert.equal(page.total, 70);
  assert.equal(page.allTotal, 140);
  assert.equal(page.returnedCount, 20);
  assert.equal(page.articles[0].id, '40');
  assert.equal(snapshot.articles.length, 140);
  assert.equal(selectArticles(snapshot, { keywords: [], offset: 0, limit: 50 }).total, 0);
  assert.equal(selectArticles(snapshot, { offset: 0, limit: 50 }).total, 140);
});

async function preferences(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hotdeal-interests-'));
  t.after(async () => { for (const file of await readdir(directory)) await unlink(join(directory, file)); await rmdir(directory); });
  const path = join(directory, 'interest-settings.json');
  const settings = new InterestSettings(path);
  await settings.initialize();
  return { path, settings };
}

test('interest settings survive restart and notify-only mode with no keywords suppresses all automatic alerts', async (t) => {
  const { path, settings } = await preferences(t);
  const posts = [{ title: 'SSD' }, { title: '생수' }];
  assert.deepEqual(settings.filterNotifications(posts), posts);
  await settings.save({ keywords: ['ssd'], notifyOnlyMatches: true });
  assert.deepEqual(settings.filterNotifications(posts), [posts[0]]);
  const restored = new InterestSettings(path);
  assert.deepEqual(await restored.initialize(), { keywords: ['ssd'], notifyOnlyMatches: true, error: null });
  await settings.save({ keywords: [], notifyOnlyMatches: true });
  assert.deepEqual(settings.filterNotifications(posts), []);
  await settings.save({ keywords: [], notifyOnlyMatches: false });
  assert.deepEqual(settings.filterNotifications(posts), posts);
});

test('invalid writes preserve saved preferences, and failed persistence never changes live notification filtering', async (t) => {
  const { path, settings } = await preferences(t);
  await settings.save({ keywords: ['ssd'], notifyOnlyMatches: true });
  const before = await readFile(path, 'utf8');
  for (const value of [null, { keywords: [], notifyOnlyMatches: 'true' }, { keywords: [], notifyOnlyMatches: false, extra: 1 }, { keywords: [''], notifyOnlyMatches: true }]) {
    assert.throws(() => settings.save(value));
  }
  assert.equal(await readFile(path, 'utf8'), before);
  const failing = new InterestSettings(path, async () => { throw new Error('disk full'); });
  await failing.initialize();
  await assert.rejects(failing.save({ keywords: [], notifyOnlyMatches: false }), /disk full/);
  assert.deepEqual(failing.read().keywords, ['ssd']);
  assert.equal(failing.read().notifyOnlyMatches, true);
});

test('corrupt interest settings fail closed without overwriting the file, and an explicit save recovers', async (t) => {
  const { path } = await preferences(t);
  await writeFile(path, '{broken');
  const settings = new InterestSettings(path);
  assert.match((await settings.initialize()).error, /기존 파일을 보존/);
  assert.deepEqual(settings.filterNotifications([{ title: 'any' }]), []);
  assert.equal(await readFile(path, 'utf8'), '{broken');
  await settings.save({ keywords: ['생수'], notifyOnlyMatches: true });
  assert.equal(settings.read().error, null);
  assert.deepEqual(settings.filterNotifications([{ title: '생수' }]), [{ title: '생수' }]);
});

test('concurrent saves serialize persistence, including recovery after a failed save', async () => {
  const writes = [];
  let fail = true;
  const settings = new InterestSettings('unused', async (_path, value) => {
    await new Promise(setImmediate);
    if (fail) { fail = false; throw new Error('disk busy'); }
    writes.push(value);
  });
  const first = settings.save({ keywords: ['first'], notifyOnlyMatches: true });
  const second = settings.save({ keywords: ['second'], notifyOnlyMatches: false });
  await assert.rejects(first, /disk busy/);
  await second;
  assert.deepEqual(writes.map(({ keywords }) => keywords), [['second']]);
  assert.deepEqual(settings.read().keywords, ['second']);
});
