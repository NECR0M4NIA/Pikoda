/**
 * effects.js
 * -----------
 * Fonctions PURES de traitement pixel. Elles ne dépendent ni du DOM (canvas)
 * ni de Node — elles travaillent directement sur un buffer RGBA
 * (Uint8Array / Uint8ClampedArray / Buffer, peu importe : même layout mémoire).
 *
 * Pourquoi c'est important : ça permet de réutiliser EXACTEMENT le même code
 * pour une image (via canvas côté renderer, ou sharp côté main process)
 * ET pour une vidéo (frame par frame, traitée côté main process avec sharp).
 *
 * Format attendu : buffer où chaque pixel = 4 octets [R, G, B, A] consécutifs.
 */

function clamp(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/* ------------------------------------------------------------------ */
/* 1. GRAIN ARGENTIQUE                                                  */
/* ------------------------------------------------------------------ */

/**
 * Ajoute du grain façon pellicule argentique.
 *
 * @param {Uint8ClampedArray|Buffer} data  buffer RGBA (mutation en place)
 * @param {number} width
 * @param {number} height
 * @param {object} options
 * @param {number} options.intensity   force du bruit, 0-100 (défaut 18)
 * @param {boolean} options.monochrome true = bruit identique sur R/G/B (look argentique classique,
 *                                      évite le bruit "coloré" qui ressemble à du bruit numérique)
 * @param {number} options.size        taille du grain en pixels (1 = fin, 2-3 = plus grossier)
 */
function addFilmGrain(data, width, height, options = {}) {
  const {
    intensity = 18,
    monochrome = true,
    size = 1,
  } = options;

  // On génère le bruit sur une grille réduite si size > 1, puis on l'étale,
  // ça simule des "grains" plus gros qu'un simple bruit pixel-à-pixel.
  const gw = Math.ceil(width / size);
  const gh = Math.ceil(height / size);
  const noiseGrid = new Float32Array(gw * gh * (monochrome ? 1 : 3));

  for (let i = 0; i < noiseGrid.length; i++) {
    // Bruit gaussien approximatif (somme de 2 uniformes = distribution
    // plus proche d'une gaussienne qu'un simple Math.random()).
    const g = (Math.random() + Math.random() - 1) * intensity;
    noiseGrid[i] = g;
  }

  for (let y = 0; y < height; y++) {
    const gy = Math.floor(y / size);
    for (let x = 0; x < width; x++) {
      const gx = Math.floor(x / size);
      const idx = (y * width + x) * 4;
      const gIdx = monochrome
        ? gy * gw + gx
        : (gy * gw + gx) * 3;

      const nR = noiseGrid[gIdx];
      const nG = monochrome ? nR : noiseGrid[gIdx + 1];
      const nB = monochrome ? nR : noiseGrid[gIdx + 2];

      data[idx] = clamp(data[idx] + nR);
      data[idx + 1] = clamp(data[idx + 1] + nG);
      data[idx + 2] = clamp(data[idx + 2] + nB);
      // canal alpha intact
    }
  }
}

/* ------------------------------------------------------------------ */
/* 2. CONVERSIONS RGB <-> HSL                                          */
/* ------------------------------------------------------------------ */

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s;
  const l = (max + min) / 2;

  if (max === min) {
    h = s = 0;
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h *= 60;
  }
  return [h, s, l];
}

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r1, g1, b1;
  if (h < 60) [r1, g1, b1] = [c, x, 0];
  else if (h < 120) [r1, g1, b1] = [x, c, 0];
  else if (h < 180) [r1, g1, b1] = [0, c, x];
  else if (h < 240) [r1, g1, b1] = [0, x, c];
  else if (h < 300) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];

  return [
    Math.round((r1 + m) * 255),
    Math.round((g1 + m) * 255),
    Math.round((b1 + m) * 255),
  ];
}

/* ------------------------------------------------------------------ */
/* 3. REMPLACEMENT DE COULEUR SÉLECTIF (précis, basé teinte)           */
/* ------------------------------------------------------------------ */

/**
 * Remplace une couleur cible par une autre, de façon "sélective" comme
 * dans Photoshop/Lightroom : on cible une plage de TEINTE (hue), avec un
 * dégradé (feather) sur les bords pour éviter les contours nets, et on
 * peut décider d'affecter aussi la saturation/luminosité ou seulement la teinte.
 *
 * @param {Uint8ClampedArray|Buffer} data  buffer RGBA (mutation en place)
 * @param {number} width
 * @param {number} height
 * @param {object} target   couleur cible à détecter, ex: {r:139,g:0,b:0}
 * @param {object} replacement couleur de remplacement, ex: {r:0,g:0,b:128}
 * @param {object} options
 * @param {number} options.hueRange   demi-largeur de la plage de teinte détectée, en degrés (défaut 20)
 * @param {number} options.feather    largeur du dégradé sur les bords, en degrés (défaut 10)
 * @param {number} options.satTolerance  tolérance sur la saturation, 0-1 (défaut 0.35)
 * @param {number} options.lightTolerance tolérance sur la luminosité, 0-1 (défaut 0.35)
 * @param {boolean} options.preserveLuminance  garde la luminosité d'origine du pixel
 *        (utile pour ne changer que la "couleur" sans aplatir les reflets/ombres)
 */
function replaceColorSelective(data, width, height, target, replacement, options = {}) {
  const {
    hueRange = 20,
    feather = 10,
    satTolerance = 0.35,
    lightTolerance = 0.35,
    preserveLuminance = true,
  } = options;

  const [targetH, targetS, targetL] = rgbToHsl(target.r, target.g, target.b);
  const [replH, replS, replL] = rgbToHsl(replacement.r, replacement.g, replacement.b);

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const [h, s, l] = rgbToHsl(r, g, b);

    // distance angulaire correcte (la teinte est circulaire, 0-360)
    let dh = Math.abs(h - targetH);
    if (dh > 180) dh = 360 - dh;

    const ds = Math.abs(s - targetS);
    const dl = Math.abs(l - targetL);

    if (dh > hueRange + feather || ds > satTolerance || dl > lightTolerance) {
      continue; // pixel hors cible, on ne touche pas
    }

    // poids du mélange : 1 = remplacement complet, 0 = pixel inchangé
    // (dégradé doux sur la zone "feather" en bord de plage de teinte)
    let weight = 1;
    if (dh > hueRange) {
      weight = 1 - (dh - hueRange) / feather;
    }

    const newH = replH;
    const newS = s + (replS - targetS) * weight; // décale la saturation relativement
    const newL = preserveLuminance ? l : l + (replL - targetL) * weight;

    const mixedH = h + (newH - h) * weight;
    const [nr, ng, nb] = hslToRgb(mixedH, clamp01(newS), clamp01(newL));

    data[i] = nr;
    data[i + 1] = ng;
    data[i + 2] = nb;
  }
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/* ------------------------------------------------------------------ */
/* 4. EXPOSITION, CONTRASTE, SATURATION, NIVEAUX                       */
/* ------------------------------------------------------------------ */

/**
 * Exposition façon photo : multiplie la lumière par 2^stops.
 * @param {number} stops  ex: +1 = deux fois plus de lumière, -1 = moitié moins (typiquement -3..+3)
 */
function adjustExposure(data, width, height, stops = 0) {
  if (stops === 0) return;
  const factor = Math.pow(2, stops);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = clamp(data[i] * factor);
    data[i + 1] = clamp(data[i + 1] * factor);
    data[i + 2] = clamp(data[i + 2] * factor);
  }
}

/**
 * Contraste classique autour du gris moyen (128).
 * @param {number} amount  -100 (plat) .. 0 (inchangé) .. 100 (très contrasté)
 */
function adjustContrast(data, width, height, amount = 0) {
  if (amount === 0) return;
  const factor = (100 + amount) / 100;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = clamp((data[i] - 128) * factor + 128);
    data[i + 1] = clamp((data[i + 1] - 128) * factor + 128);
    data[i + 2] = clamp((data[i + 2] - 128) * factor + 128);
  }
}

/**
 * Saturation par interpolation avec le niveau de gris du pixel
 * (préserve la luminosité, contrairement à un simple scale en HSL).
 * @param {number} amount  -100 (noir et blanc) .. 0 (inchangé) .. 100 (saturation doublée)
 */
function adjustSaturation(data, width, height, amount = 0) {
  if (amount === 0) return;
  const factor = 1 + amount / 100;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const gray = 0.299 * r + 0.587 * g + 0.114 * b;
    data[i] = clamp(gray + (r - gray) * factor);
    data[i + 1] = clamp(gray + (g - gray) * factor);
    data[i + 2] = clamp(gray + (b - gray) * factor);
  }
}

/**
 * Niveaux façon Photoshop/Lightroom : point noir/blanc d'entrée, gamma
 * (milieux de tons), point noir/blanc de sortie. Appliqué de façon
 * identique sur R/G/B (réglage "master", pas canal par canal).
 *
 * @param {object} options
 * @param {number} options.inputBlack   0-255, défaut 0
 * @param {number} options.inputWhite   0-255, défaut 255
 * @param {number} options.gamma        0.1-9.9, défaut 1 (1 = pas de changement des tons moyens)
 * @param {number} options.outputBlack  0-255, défaut 0
 * @param {number} options.outputWhite  0-255, défaut 255
 */
function applyLevels(data, width, height, options = {}) {
  const {
    inputBlack = 0,
    inputWhite = 255,
    gamma = 1,
    outputBlack = 0,
    outputWhite = 255,
  } = options;

  const inRange = Math.max(1, inputWhite - inputBlack); // évite la division par zéro
  const outRange = outputWhite - outputBlack;
  const invGamma = 1 / gamma;

  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      let v = clamp01((data[i + c] - inputBlack) / inRange);
      v = Math.pow(v, invGamma);
      data[i + c] = clamp(outputBlack + v * outRange);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 5. PIPELINE CENTRAL                                                  */
/* ------------------------------------------------------------------ */

/**
 * Applique tous les filtres activés, dans un ordre cohérent :
 * exposition -> niveaux -> contraste -> saturation -> teinte sélective -> grain.
 * Chaque filtre est indépendant : s'il est absent ou `enabled: false`, on le saute.
 * C'est la fonction unique utilisée par l'aperçu live, l'export image et l'export vidéo,
 * pour garantir un résultat identique entre les trois.
 *
 * @param {object} settings
 * @param {object} [settings.exposure]    { enabled, stops }
 * @param {object} [settings.levels]      { enabled, inputBlack, inputWhite, gamma, outputBlack, outputWhite }
 * @param {object} [settings.contrast]    { enabled, amount }
 * @param {object} [settings.saturation]  { enabled, amount }
 * @param {object} [settings.colorSwaps]  { enabled, swaps: [{ target, replacement, options }] }
 * @param {object} [settings.grain]       { enabled, intensity, monochrome, size }
 */
function applyPipeline(data, width, height, settings = {}) {
  const { exposure, levels, contrast, saturation, colorSwaps, grain } = settings;

  if (exposure?.enabled) adjustExposure(data, width, height, exposure.stops ?? 0);
  if (levels?.enabled) applyLevels(data, width, height, levels);
  if (contrast?.enabled) adjustContrast(data, width, height, contrast.amount ?? 0);
  if (saturation?.enabled) adjustSaturation(data, width, height, saturation.amount ?? 0);

  if (colorSwaps?.enabled && Array.isArray(colorSwaps.swaps)) {
    for (const swap of colorSwaps.swaps) {
      replaceColorSelective(data, width, height, swap.target, swap.replacement, swap.options || {});
    }
  }

  if (grain?.enabled) addFilmGrain(data, width, height, grain);

  return data;
}

module.exports = {
  addFilmGrain,
  replaceColorSelective,
  adjustExposure,
  adjustContrast,
  adjustSaturation,
  applyLevels,
  applyPipeline,
  rgbToHsl,
  hslToRgb,
};