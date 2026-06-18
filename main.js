const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');

const { processImage } = require('./effects/imageProcessor');
const { processVideo } = require('./effects/videoProcessor');

if (process.env.NODE_ENV !== 'production') {
  require('electron-reload')(__dirname);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 768,
    backgroundColor: '#1c1814',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile('index.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ---------------- Handlers IPC ---------------- */

ipcMain.handle('select-file', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Choisir une photo ou une vidéo',
    properties: ['openFile'],
    filters: [
      { name: 'Images et vidéos', extensions: ['jpg', 'jpeg', 'png', 'webp', 'tiff', 'mp4', 'mov', 'mkv', 'avi', 'webm'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('process-image', async (event, { inputPath, outputPath, options }) => {
  return processImage(inputPath, outputPath, options);
});

ipcMain.handle('process-video', async (event, { inputPath, outputPath, options }) => {
  return processVideo(inputPath, outputPath, options, (progress) => {
    event.sender.send('video-progress', progress);
  });
});