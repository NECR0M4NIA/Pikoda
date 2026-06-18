const { contextBridge, ipcRenderer, webUtils } = require('electron');
// adapte ce chemin selon où tu as mis le dossier "effects" dans ton projet
const path = require('path');
const { applyPipeline } = require(path.join(__dirname, 'effects', 'effects.js'));

contextBridge.exposeInMainWorld('filmLook', {
  selectFile: () => ipcRenderer.invoke('select-file'),
  processImage: (args) => ipcRenderer.invoke('process-image', args),
  processVideo: (args) => ipcRenderer.invoke('process-video', args),
  onVideoProgress: (callback) => ipcRenderer.on('video-progress', (event, progress) => callback(progress)),
  // Electron 32+ : .path n'existe plus sur les objets File du drag&drop,
  // il faut passer par webUtils côté preload pour récupérer le chemin réel.
  getPathForFile: (file) => webUtils.getPathForFile(file),

  // Aperçu live : exécute le MÊME pipeline que l'export final (effects.js
  // -> applyPipeline), mais en direct dans le preload, sans sharp/ffmpeg
  // ni écriture disque. Le contextBridge clone "data" en entrée et le
  // résultat en sortie (structured clone) -> ce n'est PAS une mutation
  // par référence, il faut récupérer la valeur de retour côté renderer.
  applyEffects: (data, width, height, settings) => {
    const buf = new Uint8ClampedArray(data); // copie locale, indépendante de l'originale
    applyPipeline(buf, width, height, settings);
    return buf;
  },
});