'use strict';

/**
 * CloneTradingView desktop shell.
 *
 * Starts the local Node chart server on a free loopback port, waits for its
 * health endpoint, then opens it in a normal (non-chromeless) desktop window.
 * User data lives under %APPDATA%/CloneTradingView so the installed app can
 * write alerts and the market cache even inside Program Files.
 */

const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');

app.setName('CloneTradingView');
if (process.platform === 'win32') app.setAppUserModelId('com.karmakarjigar.clonetradingview');

const isDev = !app.isPackaged;
const serverRoot = isDev
  ? path.join(__dirname, '..')
  : path.join(process.resourcesPath, 'app-server');
const serverEntry = path.join(serverRoot, 'server.js');
const iconPath = isDev
  ? path.join(__dirname, '..', 'build', 'icon.ico')
  : path.join(process.resourcesPath, 'icon.ico');

let mainWindow = null;
let serverProc = null;
let serverPort = 0;
let serverLog = null;
let booting = false;
const MAX_LOG_BYTES = 2 * 1024 * 1024;

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}\n`;
  try { serverLog?.write(stamped); } catch { /* noop */ }
  if (isDev) process.stdout.write(stamped);
}

/* ---------------- local server ---------------- */

function portIsFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

async function pickPort() {
  // Prefer the documented port, then walk upward when a dev server or another
  // copy already owns it.
  for (let port = 5577; port < 5650; port += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await portIsFree(port)) return port;
  }
  return 0;
}

function startServer(port) {
  const dataDir = path.join(app.getPath('userData'), 'data');
  const cacheDir = path.join(app.getPath('userData'), 'cache');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  try {
    if (fs.statSync(path.join(app.getPath('userData'), 'desktop.log')).size > MAX_LOG_BYTES) {
      fs.renameSync(
        path.join(app.getPath('userData'), 'desktop.log'),
        path.join(app.getPath('userData'), 'desktop.old.log'),
      );
    }
  } catch { /* first run */ }

  serverLog = fs.createWriteStream(path.join(app.getPath('userData'), 'desktop.log'), { flags: 'a' });
  log(`starting server on 127.0.0.1:${port}`);
  log(`server root: ${serverRoot}`);

  const env = {
    ...process.env,
    PORT: String(port),
    TVFREE_DATA_DIR: dataDir,
    TVFREE_CACHE_DIR: cacheDir,
    ELECTRON_RUN_AS_NODE: '1',
  };

  serverProc = spawn(process.execPath, [serverEntry], {
    cwd: serverRoot,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProc.stdout.on('data', (chunk) => log(chunk.toString().trimEnd()));
  serverProc.stderr.on('data', (chunk) => log(`ERR ${chunk.toString().trimEnd()}`));
  serverProc.on('error', (err) => log(`spawn error: ${err.message}`));
  serverProc.on('exit', (code, signal) => {
    log(`server exited (${code ?? signal})`);
    if (!booting && !app.isQuitting) {
      dialog.showMessageBox({
        type: 'error',
        title: 'CloneTradingView server stopped',
        message: 'The local chart server stopped unexpectedly.',
        detail: `Exit code: ${code ?? signal}\nLog: ${path.join(app.getPath('userData'), 'desktop.log')}`,
        buttons: ['Open log', 'Quit'],
      }).then(({ response }) => {
        if (response === 0) shell.openPath(path.join(app.getPath('userData'), 'desktop.log'));
        app.quit();
      });
    }
  });
}

function ping(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/health', timeout: 1200 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function waitForServer(port, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    if (await ping(port)) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/* ---------------- window ---------------- */

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#131722',
    title: 'CloneTradingView',
    autoHideMenuBar: true,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const base = `http://127.0.0.1:${port}`;
    if (!url.startsWith(base)) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  // Keep a debugging escape hatch for support calls; the page itself owns F5.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}/`);
}

/* ---------------- lifecycle ---------------- */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    booting = true;
    Menu.setApplicationMenu(null);

    serverPort = await pickPort();
    if (!serverPort) {
      dialog.showErrorBox('CloneTradingView', 'No free local port was found on 127.0.0.1.');
      app.quit();
      return;
    }

    startServer(serverPort);
    const ready = await waitForServer(serverPort);
    booting = false;

    if (!ready) {
      log('health check timed out');
      const { response } = await dialog.showMessageBox({
        type: 'error',
        title: 'CloneTradingView could not start',
        message: 'The local chart server did not become ready.',
        detail: `Port: ${serverPort}\nLog: ${path.join(app.getPath('userData'), 'desktop.log')}`,
        buttons: ['Open log', 'Quit'],
      });
      if (response === 0) shell.openPath(path.join(app.getPath('userData'), 'desktop.log'));
      app.quit();
      return;
    }

    createWindow(serverPort);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(serverPort);
    });
  }).catch((err) => {
    log(`boot failed: ${err && err.stack ? err.stack : err}`);
    dialog.showErrorBox(
      'CloneTradingView could not start',
      `${err && err.message ? err.message : err}\n\nLog: ${path.join(app.getPath('userData'), 'desktop.log')}`,
    );
    app.quit();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', () => {
    app.isQuitting = true;
    if (serverProc) {
      try { serverProc.kill(); } catch { /* already gone */ }
      serverProc = null;
    }
    try { serverLog?.end(); } catch { /* noop */ }
  });
}
