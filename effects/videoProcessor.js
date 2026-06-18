/**
 * videoProcessor.js
 * ------------------
 * Pipeline vidéo "frame par frame" qui réutilise EXACTEMENT les mêmes
 * fonctions que pour une image fixe (effects.js). On pilote directement
 * le binaire ffmpeg via child_process (pas besoin de fluent-ffmpeg).
 *
 * Pré-requis : ffmpeg installé sur la machine (ou fourni via le package
 * `ffmpeg-static` si tu veux l'embarquer dans ton app Electron — dans ce
 * cas remplace FFMPEG_PATH ci-dessous par require('ffmpeg-static')).
 *
 * Étapes :
 *   1. Extraire le framerate de la vidéo source (ffprobe)
 *   2. Extraire toutes les frames en PNG dans un dossier temporaire
 *   3. Appliquer les effets sur chaque frame (sharp, en parallèle par lots)
 *   4. Réassembler les frames traitées en vidéo + remuxer l'audio d'origine
 *
 * ATTENTION PERFORMANCE :
 * Cette approche traite chaque pixel de chaque frame en JS : c'est précis
 * et flexible (mêmes réglages que pour une photo), mais plus lent qu'un
 * filtre ffmpeg natif. Pour une vidéo de quelques secondes/minutes en 1080p
 * c'est tout à fait jouable sur un poste récent. Pour du gros volume,
 * on pourra envisager de migrer la conversion couleur vers un filtre
 * ffmpeg natif (`lut3d`, `curves`, `geq`) une fois le rendu visuel validé ici.
 */

const { spawn } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const sharp = require('sharp');
const { applyPipeline } = require('./effects');

const FFMPEG_PATH = 'ffmpeg';   // ou require('ffmpeg-static') si tu l'embarques
const FFPROBE_PATH = 'ffprobe'; // idem, voir le package ffprobe-static

function runCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(`${cmd} a échoué (code ${code}):\n${stderr}`));
    });
  });
}

async function getFrameRate(inputPath) {
  const out = await runCommand(FFPROBE_PATH, [
    '-v', '0',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=r_frame_rate',
    '-of', 'csv=p=0',
    inputPath,
  ]).catch(async () => {
    // ffprobe écrit parfois sur stdout, pas stderr -> on relit autrement si besoin
    return null;
  });
  // ffprobe renvoie un résultat sur stdout normalement ; on le relit proprement :
  return new Promise((resolve, reject) => {
    const proc = spawn(FFPROBE_PATH, [
      '-v', '0', '-select_streams', 'v:0',
      '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', inputPath,
    ]);
    let stdout = '';
    proc.stdout.on('data', (d) => stdout += d.toString());
    proc.on('close', () => {
      const raw = stdout.trim(); // format "30/1" ou "30000/1001"
      const [num, den] = raw.split('/').map(Number);
      resolve(den ? num / den : num || 30);
    });
    proc.on('error', reject);
  });
}

async function extractFrames(inputPath, framesDir) {
  await fs.mkdir(framesDir, { recursive: true });
  await runCommand(FFMPEG_PATH, [
    '-y', '-i', inputPath,
    path.join(framesDir, 'frame_%06d.png'),
  ]);
}

async function processFrame(framePath, settings) {
  const image = sharp(framePath);
  const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;

  applyPipeline(data, width, height, settings);

  await sharp(data, { raw: { width, height, channels: 4 } }).toFile(framePath);
}

/**
 * Traite toutes les frames d'un dossier, par lots, pour ne pas saturer la RAM/CPU.
 */
async function processAllFrames(framesDir, settings, concurrency = os.cpus().length) {
  const files = (await fs.readdir(framesDir)).filter(f => f.endsWith('.png')).sort();
  let i = 0;
  async function worker() {
    while (i < files.length) {
      const idx = i++;
      await processFrame(path.join(framesDir, files[idx]), settings);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return files.length;
}

async function reassembleVideo(framesDir, fps, originalInputPath, outputPath) {
  await runCommand(FFMPEG_PATH, [
    '-y',
    '-framerate', String(fps),
    '-i', path.join(framesDir, 'frame_%06d.png'),
    '-i', originalInputPath,
    '-map', '0:v',
    '-map', '1:a?', // '?' = ne plante pas s'il n'y a pas de piste audio
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-shortest',
    outputPath,
  ]);
}

/**
 * @param {string} inputPath
 * @param {string} outputPath
 * @param {object} settings  voir applyPipeline dans effects.js
 * @param {function} [onProgress]  callback({ stage, current, total })
 */
async function processVideo(inputPath, outputPath, settings = {}, onProgress = () => {}) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'film-look-'));
  const framesDir = path.join(workDir, 'frames');
  try {
    onProgress({ stage: 'analyse' });
    const fps = await getFrameRate(inputPath);

    onProgress({ stage: 'extraction' });
    await extractFrames(inputPath, framesDir);

    onProgress({ stage: 'traitement' });
    const total = await processAllFrames(framesDir, settings);
    onProgress({ stage: 'traitement', current: total, total });

    onProgress({ stage: 'assemblage' });
    await reassembleVideo(framesDir, fps, inputPath, outputPath);

    onProgress({ stage: 'terminé' });
    return { outputPath, fps, frameCount: total };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

module.exports = { processVideo };