/**
 * imageProcessor.js
 * ------------------
 * Pipeline de traitement pour une image fixe.
 * Utilise `sharp` pour décoder n'importe quel format (jpg, png, webp, tiff...)
 * en buffer RGBA brut, applique les effets de effects.js, puis réencode.
 *
 * Installation : npm install sharp
 */

const sharp = require('sharp');
const { applyPipeline } = require('./effects');

/**
 * @param {string} inputPath   chemin du fichier image source
 * @param {string} outputPath  chemin du fichier de sortie (l'extension détermine le format)
 * @param {object} settings    voir applyPipeline dans effects.js (exposure, levels, contrast,
 *                              saturation, colorSwaps, grain — chacun avec son flag `enabled`)
 */
async function processImage(inputPath, outputPath, settings = {}) {
  const image = sharp(inputPath);
  const { data, info } = await image
    .ensureAlpha() // garantit 4 canaux RGBA même pour un JPEG sans alpha
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = info;

  applyPipeline(data, width, height, settings);

  await sharp(data, { raw: { width, height, channels: 4 } })
    .toFile(outputPath);

  return { width, height, outputPath };
}

module.exports = { processImage };