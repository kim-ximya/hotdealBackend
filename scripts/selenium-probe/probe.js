// Standalone, visible-browser probe. No stealth flags, CAPTCHA automation,
// cookie import, recurring crawling, or changes to the existing backend.
import { Builder } from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArticleList } from '../../src/article-parser.js';

const targetUrl = 'https://arca.live/b/hotdeal';
const directory = resolve(import.meta.dirname, '../../.local/selenium-probe');
const runName = new Date().toISOString().replace(/[:.]/g, '-');
const waitSeconds = Number(process.env.ARCA_SELENIUM_WAIT_SECONDS || 120);
const startedAt = Date.now();
let driver;

function inspectDocument() {
  const table = document.querySelector('.article-list .list-table');
  const ids = new Set();
  if (table) {
    for (const row of table.querySelectorAll('.vrow:not(.notice):not(.notice-service):not(.head):not(.notice-unfilter)')) {
      const anchors = row.matches('a[href]') ? [row] : row.querySelectorAll('a.title[href], .col-title a[href]');
      for (const anchor of anchors) {
        const url = new URL(anchor.getAttribute('href'), location.href);
        const match = url.pathname.match(/^\/b\/hotdeal\/(\d+)\/?$/);
        if (url.origin === 'https://arca.live' && match) ids.add(match[1]);
      }
    }
  }
  const navigation = performance.getEntriesByType('navigation')[0];
  return {
    url: location.origin + location.pathname,
    title: document.title,
    readyState: document.readyState,
    webdriver: navigator.webdriver,
    hasArticleList: Boolean(table),
    regularPostCount: ids.size,
    httpStatus: navigation?.responseStatus > 0 ? navigation.responseStatus : null,
    challengeDetected: /just a moment|잠시만/i.test(document.title) || Boolean(document.querySelector('#challenge-running, #cf-challenge-running, #challenge-stage')),
  };
}

try {
  if (!Number.isInteger(waitSeconds) || waitSeconds < 1 || waitSeconds > 600) {
    throw new Error('ARCA_SELENIUM_WAIT_SECONDS는 1~600 사이의 정수여야 합니다.');
  }
  await mkdir(directory, { recursive: true });
  // Keep Manager downloads/configuration inside the project and avoid installing a browser.
  process.env.SE_CACHE_PATH = resolve(directory, 'driver-cache');
  process.env.SE_AVOID_STATS = 'true';
  process.env.SE_AVOID_BROWSER_DOWNLOAD = 'true';
  process.env.SE_TIMEOUT = '60';

  const options = new chrome.Options();
  options.addArguments(`--user-data-dir=${resolve(directory, 'profile')}`, '--window-size=1200,900');
  if (process.env.ARCA_SELENIUM_CHROME_BINARY) {
    options.setChromeBinaryPath(process.env.ARCA_SELENIUM_CHROME_BINARY);
  }
  console.log('Selenium과 ChromeDriver를 준비합니다. 첫 실행 시 공식 드라이버를 내려받을 수 있습니다.');
  driver = await new Builder().forBrowser('chrome').setChromeOptions(options).build();
  await driver.manage().setTimeouts({ pageLoad: 30_000, script: 10_000, implicit: 0 });
  const capabilities = await driver.getCapabilities();
  console.log(`Chrome ${capabilities.get('browserVersion')}에서 핫딜 페이지에 접속합니다.`);

  let navigationError = null;
  try {
    await driver.get(targetUrl);
  } catch (error) {
    if (error.name !== 'TimeoutError') throw error;
    navigationError = '페이지 로드 제한 시간(30초)을 초과했습니다.';
  }
  const initial = await driver.executeScript(inspectDocument);
  console.log(`최초 상태: ${JSON.stringify(initial)}`);
  let waitTimedOut = false;
  if (!initial.hasArticleList || initial.regularPostCount === 0) {
    console.log(`보안 확인이 보이면 열린 Chrome에서 직접 완료하세요. 목록이 나타날 때까지 최대 ${waitSeconds}초 기다립니다.`);
    try {
      await driver.wait(async () => {
        const state = await driver.executeScript(inspectDocument);
        return state.hasArticleList && state.regularPostCount > 0;
      }, waitSeconds * 1000, '일반 핫딜 게시글 목록을 확인하지 못했습니다.', 1000);
    } catch (error) {
      if (error.name !== 'TimeoutError') throw error;
      waitTimedOut = true;
    }
  }

  const final = await driver.executeScript(inspectDocument);
  const html = await driver.getPageSource();
  const htmlPath = resolve(directory, `${runName}.html`);
  const screenshotPath = resolve(directory, `${runName}.png`);
  const reportPath = resolve(directory, `${runName}.json`);
  await writeFile(htmlPath, html);
  await writeFile(screenshotPath, Buffer.from(await driver.takeScreenshot(), 'base64'));
  let articles = null;
  let parseError = null;
  let articlesPath = null;
  if (final.hasArticleList && final.regularPostCount > 0) {
    try {
      articles = parseArticleList(html);
      articlesPath = resolve(directory, `${runName}.articles.json`);
      await writeFile(articlesPath, JSON.stringify(articles, null, 2) + '\n');
    } catch (error) {
      parseError = error.message;
    }
  }
  const listDetected = final.hasArticleList && final.regularPostCount > 0;
  const report = {
    requestedUrl: targetUrl,
    checkedAt: new Date().toISOString(),
    browser: 'chrome',
    browserVersion: capabilities.get('browserVersion'),
    elapsedMs: Date.now() - startedAt,
    waitTimedOut,
    navigationError,
    initial,
    final,
    listDetected,
    parsedArticleCount: articles?.length ?? null,
    parseError,
    htmlPath,
    screenshotPath,
    articlesPath,
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  console.log(`진단 파일: ${reportPath}`);
  console.log(listDetected ? 'Selenium 브라우저에서 일반 핫딜 목록 HTML을 확인했습니다.' : '브라우저는 열렸지만 일반 핫딜 목록을 확인하지 못했습니다.');
  if (!listDetected || parseError) process.exitCode = 1;
} catch (error) {
  const report = {
    requestedUrl: targetUrl, checkedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt, error: error.message,
  };
  await mkdir(directory, { recursive: true });
  const reportPath = resolve(directory, `${runName}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.error(JSON.stringify(report, null, 2));
  console.error(`진단 파일: ${reportPath}`);
  process.exitCode = 1;
} finally {
  if (driver) await driver.quit().catch((error) => console.error(`테스트 브라우저 종료 실패: ${error.message}`));
}
