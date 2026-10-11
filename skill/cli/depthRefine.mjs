// Refina o depth map cru (Depth-Anything) "colando" suas bordas nas bordas REAIS da imagem.
//
// Por quê: o modelo "small" roda numa resolução interna baixa e o mapa de profundidade
// resultante sai como um blob suavizado — ele acerta "o que é perto vs longe" em grosso,
// mas perde contorno fino (galhos, folhas, cabelo). Quando o shader desloca por profundidade,
// o contorno fino da IMAGEM se move seguindo o contorno GROSSEIRO do depth, e como os dois
// não coincidem, o resultado "ondula"/duplica o contorno real (fantasma 2.5D).
//
// Fix: guided filter (He et al., O(1) por pixel via box filter/soma cumulativa) usando a
// LUMINÂNCIA da imagem original como guia. Em região lisa (sem textura na imagem) ele só
// suaviza o depth; em região com borda forte na imagem (como o contorno de um galho contra o
// céu) ele força o depth a replicar essa borda — a transição perto→longe "gruda" no pixel
// certo em vez de ficar alguns px deslocada/borrada.
import sharp from 'sharp';

async function loadGrayNormalized(path, w, h) {
  const { data, info } = await sharp(path)
    .resize(w, h, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  const n = w * h;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * ch;
    out[i] = ch >= 3
      ? (0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]) / 255
      : data[o] / 255;
  }
  return out;
}

// box filter exato via soma de área somada (integral image) — O(1) por pixel, qualquer raio.
function boxFilter(src, w, h, r) {
  const sat = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowsum = 0;
    const satRow = (y + 1) * (w + 1);
    const satPrevRow = y * (w + 1);
    for (let x = 0; x < w; x++) {
      rowsum += src[y * w + x];
      sat[satRow + x + 1] = sat[satPrevRow + x + 1] + rowsum;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
    const rowA = (y1 + 1) * (w + 1), rowB = y0 * (w + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum = sat[rowA + x1 + 1] - sat[rowB + x1 + 1] - sat[rowA + x0] + sat[rowB + x0];
      out[y * w + x] = sum / area;
    }
  }
  return out;
}

export async function guidedRefineDepth(imagePath, depthPath, outPath, opts = {}) {
  const radius = opts.radius ?? 16;
  const eps = opts.eps ?? 1e-3;
  const meta = await sharp(depthPath).metadata();
  const w = meta.width, h = meta.height;
  const n = w * h;

  const I = await loadGrayNormalized(imagePath, w, h); // guia: luminância da foto original
  const p = await loadGrayNormalized(depthPath, w, h); // entrada: depth cru

  const meanI = boxFilter(I, w, h, radius);
  const meanP = boxFilter(p, w, h, radius);
  const Ip = new Float32Array(n), II = new Float32Array(n);
  for (let i = 0; i < n; i++) { Ip[i] = I[i] * p[i]; II[i] = I[i] * I[i]; }
  const corrIp = boxFilter(Ip, w, h, radius);
  const corrII = boxFilter(II, w, h, radius);

  const a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const varI = corrII[i] - meanI[i] * meanI[i];
    const covIp = corrIp[i] - meanI[i] * meanP[i];
    a[i] = covIp / (varI + eps);
    b[i] = meanP[i] - a[i] * meanI[i];
  }
  const meanA = boxFilter(a, w, h, radius);
  const meanB = boxFilter(b, w, h, radius);

  const q = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    const v = meanA[i] * I[i] + meanB[i];
    q[i] = Math.round(Math.max(0, Math.min(1, v)) * 255);
  }
  await sharp(q, { raw: { width: w, height: h, channels: 1 } }).png().toFile(outPath);
  return outPath;
}
