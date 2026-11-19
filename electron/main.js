// MeyJournal — Windows desktop shell (Electron)
const { app, BrowserWindow, shell, Menu } = require('electron');
const path = require('path');

if (!app.requestSingleInstanceLock()) app.quit();

function createWindow() {
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 380,
    minHeight: 600,
    title: 'MeyJournal',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    backgroundColor: '#F5F2EC',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true }
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, '..', 'www', 'index.html'));

  // Open external links in the default browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });

  // PDF export: show a normal "Save as" dialog.
  win.webContents.session.on('will-download', (_e, item) => {
    item.setSaveDialogOptions({ title: 'Save photo book', defaultPath: path.join(app.getPath('documents'), item.getFilename()) });
  });
}

app.on('second-instance', () => { const w = BrowserWindow.getAllWindows()[0]; if (w) { if (w.isMinimized()) w.restore(); w.focus(); } });
app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
