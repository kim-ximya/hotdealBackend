const path = require('node:path');

function runtimePaths({ packaged, root, appData, env = process.env, managerPackagePath }) {
  const userData = env.HOTDEAL_USER_DATA_DIR
    ? path.resolve(env.HOTDEAL_USER_DATA_DIR)
    : packaged ? path.join(appData, 'HotdealCollector') : path.join(root, '.local', 'desktop');
  return {
    userData,
    cwd: packaged ? userData : root,
    configRoot: packaged ? userData : root,
    dataDirectory: env.DATA_DIR || (packaged ? path.join(userData, 'collector') : undefined),
    // spawnSync cannot execute a binary inside Electron's ASAR archive.
    managerPath: packaged ? path.join(path.dirname(managerPackagePath), 'bin', 'windows', 'selenium-manager.exe')
      .replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2') : undefined,
  };
}

module.exports = { runtimePaths };
