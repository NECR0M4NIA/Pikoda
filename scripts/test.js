const {
  addFilmGrain, replaceColorSelective, rgbToHsl, hslToRgb,
  adjustExposure, adjustContrast, adjustSaturation, applyLevels, applyPipeline,
} = require('./effects');

// --- Test 1: grain ne doit pas crasher et doit modifier les pixels ---
const w = 50, h = 50;
const buf = new Uint8ClampedArray(w * h * 4);
for (let i = 0; i < buf.length; i += 4) {
  buf[i] = 128; buf[i+1] = 128; buf[i+2] = 128; buf[i+3] = 255;
}
const before = buf.slice();
addFilmGrain(buf, w, h, { intensity: 20, monochrome: true });
let changed = 0;
for (let i = 0; i < buf.length; i += 4) {
  if (buf[i] !== before[i]) changed++;
}
console.log(`[Grain] pixels modifiés: ${changed}/${w*h} (attendu > 0)`);

// --- Test 2: round-trip RGB -> HSL -> RGB doit redonner ~la même couleur ---
const testColors = [[139,0,0],[0,0,128],[128,128,0],[255,255,255],[0,0,0]];
for (const [r,g,b] of testColors) {
  const [hh,ss,ll] = rgbToHsl(r,g,b);
  const [r2,g2,b2] = hslToRgb(hh,ss,ll);
  const diff = Math.abs(r-r2)+Math.abs(g-g2)+Math.abs(b-b2);
  console.log(`[HSL round-trip] (${r},${g},${b}) -> (${r2},${g2},${b2}) diff=${diff}`);
}

// --- Test 3: remplacement de couleur sélectif sur une image avec 2 zones ---
const w2 = 10, h2 = 1;
const buf2 = new Uint8ClampedArray(w2 * h2 * 4);
// 5 pixels "rouge sanglant" (139,0,0), 5 pixels "vert olive" (128,128,0)
for (let x = 0; x < w2; x++) {
  const idx = x * 4;
  if (x < 5) { buf2[idx]=139; buf2[idx+1]=0; buf2[idx+2]=0; buf2[idx+3]=255; }
  else { buf2[idx]=128; buf2[idx+1]=128; buf2[idx+2]=0; buf2[idx+3]=255; }
}
replaceColorSelective(buf2, w2, h2, {r:139,g:0,b:0}, {r:0,g:0,b:128}, { hueRange: 15, feather: 5 });
const pixelsOut = [];
for (let x = 0; x < w2; x++) {
  const idx = x*4;
  pixelsOut.push([buf2[idx], buf2[idx+1], buf2[idx+2]]);
}
console.log('[ColorReplace] pixels après traitement:', JSON.stringify(pixelsOut));
console.log('Attendu: les 5 premiers pixels (rouge) -> proches du bleu marine (0,0,128), les 5 derniers (vert olive) inchangés (128,128,0)');

// --- Test 4: exposition, contraste, saturation, niveaux ---
function makeFlat(w, h, r, g, b) {
  const buf = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < buf.length; i += 4) { buf[i]=r; buf[i+1]=g; buf[i+2]=b; buf[i+3]=255; }
  return buf;
}

let buf4 = makeFlat(2, 2, 100, 100, 100);
adjustExposure(buf4, 2, 2, 1);
console.log('[Exposition +1] 100 ->', buf4[0], '(attendu ~200)');

buf4 = makeFlat(2, 2, 180, 180, 180);
adjustContrast(buf4, 2, 2, 100);
console.log('[Contraste +100] 180 ->', buf4[0], '(attendu 232)');

buf4 = makeFlat(2, 2, 200, 50, 50);
adjustSaturation(buf4, 2, 2, -100);
console.log('[Saturation -100] (200,50,50) ->', buf4[0], buf4[1], buf4[2], '(attendu gris, R=G=B)');

buf4 = makeFlat(2, 2, 50, 125, 200);
applyLevels(buf4, 2, 2, { inputBlack: 50, inputWhite: 200 });
console.log('[Niveaux 50-200] (50,125,200) ->', buf4[0], buf4[1], buf4[2], '(attendu ~0, ~127, ~255)');

// --- Test 5: pipeline respecte les flags enabled ---
buf4 = makeFlat(2, 2, 139, 0, 0);
const before4 = buf4.slice();
applyPipeline(buf4, 2, 2, {
  exposure: { enabled: false, stops: 2 },
  contrast: { enabled: false, amount: 80 },
  saturation: { enabled: false, amount: -80 },
  grain: { enabled: false, intensity: 50 },
});
console.log('[Pipeline tout désactivé] inchangé ?', buf4.every((v, i) => v === before4[i]));

buf4 = makeFlat(2, 2, 200, 50, 50);
applyPipeline(buf4, 2, 2, {
  exposure: { enabled: false, stops: 3 },     // ne doit pas s'appliquer
  saturation: { enabled: true, amount: -100 }, // doit s'appliquer seul
});
console.log('[Pipeline saturation seule] ->', buf4[0], buf4[1], buf4[2], '(attendu gris, pas d\'effet exposition)');