const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, screen, shell, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { getSnapshot } = require('./data-service');

let mainWindow;
let tray;
let quitting = false;
const defaults = { alwaysOnTop: true, opacity: 0.96, compact: false, autoRefresh: true, refreshInterval: 1, x: null, y: null };
let preferences = { ...defaults };
let compactRunningSessions = 0;
let movingWindow = false;
let moveEndTimer = null;
let pendingContentSize = null;
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  quitting = true;
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

function compactHeight() {
  const desired = 134 + Math.max(0, compactRunningSessions) * 66;
  return Math.min(desired, screen.getPrimaryDisplay().workArea.height - 40);
}

function preferencesPath() { return path.join(app.getPath('userData'), 'monitor-preferences.json'); }
function loadPreferences() {
  try { preferences = { ...defaults, ...JSON.parse(fs.readFileSync(preferencesPath(), 'utf8')), refreshInterval: 1 }; } catch { preferences = { ...defaults }; }
}
function savePreferences() { fs.writeFileSync(preferencesPath(), JSON.stringify(preferences, null, 2)); }

function createAppIcon(size = 32) {
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.ico');
  if (fs.existsSync(iconPath)) return nativeImage.createFromPath(iconPath).resize({ width: size, height: size });
  return nativeImage.createEmpty();
}
function createTrayIcon() { return createAppIcon(16); }

function createWindow() {
  const display = screen.getPrimaryDisplay().workArea;
  const width = 390;
  const height = preferences.compact ? compactHeight() : 860;
  mainWindow = new BrowserWindow({
    width, height,
    x: Number.isFinite(preferences.x) ? preferences.x : display.x + display.width - width - 20,
    y: Number.isFinite(preferences.y) ? preferences.y : display.y + 20,
    minWidth: 340, minHeight: preferences.compact ? compactHeight() : 450,
    maxWidth: 480,
    frame: false, transparent: true, resizable: !preferences.compact,
    icon: createAppIcon(32),
    alwaysOnTop: preferences.alwaysOnTop, skipTaskbar: true,
    show: false, backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  mainWindow.setOpacity(preferences.opacity);
  preferences.alwaysOnTop = true;
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.webContents.on('console-message', (_event, _level, message) => { console.log('[renderer]', message); });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('blur', () => {
    if (!mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(true, 'screen-saver');
  });
  mainWindow.on('will-move', () => { movingWindow = true; });
  mainWindow.on('move', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    movingWindow = true;
    clearTimeout(moveEndTimer);
    moveEndTimer = setTimeout(() => {
      movingWindow = false;
      if (pendingContentSize) { const [width, height] = pendingContentSize; pendingContentSize = null; mainWindow.setContentSize(width, height, false); }
    }, 180);
    const [x, y] = mainWindow.getPosition();
    preferences.x = x; preferences.y = y; savePreferences();
  });
  mainWindow.on('close', (event) => {
    if (!quitting) { event.preventDefault(); mainWindow.hide(); }
  });
}

function setCompact(compact) {
  preferences.compact = Boolean(compact);
  savePreferences();
  const [width] = mainWindow.getSize();
  mainWindow.setResizable(!preferences.compact);
  const height = preferences.compact ? compactHeight() : 860;
  mainWindow.setMinimumSize(340, preferences.compact ? height : 450);
  mainWindow.setSize(width, height, true);
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.webContents.send('window:compact-changed', preferences.compact);
  return preferences.compact;
}
function toggleCompact() { return setCompact(!preferences.compact); }

app.whenReady().then(() => {
  loadPreferences();
  createWindow();
  tray = new Tray(createTrayIcon());
  tray.setToolTip('DSH helper');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示监控悬浮窗', click: () => mainWindow.show() },
    { label: '折叠 / 展开', click: toggleCompact },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } }
  ]));
  tray.on('click', () => mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show());
});

app.on('window-all-closed', (event) => event.preventDefault());
app.on('before-quit', () => { quitting = true; });

const readSnapshot = () => getSnapshot({ fetcher: net.fetch });
ipcMain.handle('monitor:get-snapshot', readSnapshot);
ipcMain.handle('monitor:refresh', () => getSnapshot({ fetcher: net.fetch, forceUsage: true }));
ipcMain.handle('preferences:get', () => preferences);
ipcMain.handle('preferences:set', (_, key, value) => {
  if (!Object.hasOwn(defaults, key)) return preferences;
  preferences[key] = value;
  if (key === 'alwaysOnTop') {
    preferences.alwaysOnTop = true;
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
  }
  if (key === 'opacity') mainWindow.setOpacity(Math.max(0.65, Math.min(1, Number(value))));
  savePreferences();
  return preferences;
});
ipcMain.handle('window:toggle-compact', toggleCompact);
ipcMain.handle('window:set-compact', (_, compact) => setCompact(compact));
ipcMain.handle('window:resize-view', (_, view, runningSessions, contentHeight, visibleHeight) => {
  compactRunningSessions = Math.max(0, Math.floor(Number(runningSessions) || 0));
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const available = screen.getPrimaryDisplay().workArea.height - 40;
  const measured = Math.max(1, Math.ceil(Number(visibleHeight) || Number(contentHeight) || 1));
  const height = Math.min(measured + 4, available);
  const width = view === 'orb' ? 210 : 390;
  if (movingWindow) { pendingContentSize = [width, height]; return true; }
  const [currentWidth, currentHeight] = mainWindow.getContentSize();
  if (currentWidth === width && currentHeight === height) return true;
  mainWindow.setMinimumSize(view === 'orb' ? 210 : 340, view === 'orb' ? height : Math.min(height, 450));
  mainWindow.setResizable(!['compact', 'orb'].includes(view));
  mainWindow.setContentSize(width, height, false);
  return true;
});
ipcMain.handle('window:minimize', () => mainWindow.minimize());
ipcMain.handle('window:hide', () => mainWindow.hide());
ipcMain.handle('external:open', async (_, value) => {
  try {
    const url = new URL(String(value));
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    await shell.openExternal(url.toString());
    return true;
  } catch {
    return false;
  }
});
ipcMain.handle('ccswitch:open-provider', async () => {
  try {
    await shell.openExternal('ccswitch://');
    return true;
  } catch {
    return false;
  }
});
ipcMain.handle('app:quit', () => { quitting = true; app.quit(); });
