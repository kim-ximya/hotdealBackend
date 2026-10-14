import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import pathsModule from '../desktop/runtime-paths.cjs';

const { runtimePaths } = pathsModule;
const root = path.resolve('demo-project');
const appData = path.resolve('demo-appdata');
const managerPackagePath = path.join(root, 'resources', 'app.asar', 'node_modules', 'selenium-webdriver', 'package.json');

test('development preserves existing data and working directory', () => {
  const result = runtimePaths({ packaged: false, root, appData, env: {} });
  assert.equal(result.userData, path.join(root, '.local', 'desktop'));
  assert.equal(result.configRoot, root);
  assert.equal(result.cwd, root);
  assert.equal(result.dataDirectory, undefined);
  assert.equal(result.managerPath, undefined);
});

test('installed app writes outside ASAR and executes the unpacked manager', () => {
  const result = runtimePaths({ packaged: true, root, appData, env: {}, managerPackagePath });
  assert.equal(result.userData, path.join(appData, 'HotdealCollector'));
  assert.equal(result.cwd, result.userData);
  assert.equal(result.configRoot, result.userData);
  assert.equal(result.dataDirectory, path.join(result.userData, 'collector'));
  assert.equal(result.managerPath, path.join(root, 'resources', 'app.asar.unpacked', 'node_modules', 'selenium-webdriver', 'bin', 'windows', 'selenium-manager.exe'));
});

test('an explicit data location can isolate a packaged run without changing defaults', () => {
  const result = runtimePaths({ packaged: true, root, appData, managerPackagePath,
    env: { HOTDEAL_USER_DATA_DIR: root, DATA_DIR: 'custom-collector' } });
  assert.equal(result.userData, root);
  assert.equal(result.dataDirectory, 'custom-collector');
  assert.equal(result.configRoot, root);
});
