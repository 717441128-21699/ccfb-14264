/**
 * 高度场 / 粗糙度可视化：热力图、网格着色、剖面曲线、照片叠加。
 */
import type { HeightField, RugosityReport } from './types';

const VIRIDIS = [
  [68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37],
];

function viridis(t: number): [number, number, number] {
  const x = Math.min(0.9999, Math.max(0, t)) * (VIRIDIS.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = VIRIDIS[i];
  const b = VIRIDIS[Math.min(VIRIDIS.length - 1, i + 1)];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

/** 高度场 → 热力 ImageData（归一化到 min..max） */
export function heightToImageData(hf: HeightField): ImageData {
  const { width: w, height: h, z } = hf;
  let mn = Infinity;
  let mx = -Infinity;
  for (const v of z) {
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  const range = Math.max(mx - mn, 1e-9);
  const out = new ImageData(w, h);
  for (let i = 0; i < z.length; i++) {
    const [r, g, b] = viridis((z[i] - mn) / range);
    out.data[i * 4] = r;
    out.data[i * 4 + 1] = g;
    out.data[i * 4 + 2] = b;
    out.data[i * 4 + 3] = 255;
  }
  return out;
}

/** 等高线/阴影浮雕图（由高度梯度生成仿晕渲） */
export function reliefToImageData(hf: HeightField, lightAzimuth = -0.7): ImageData {
  const { width: w, height: h, z } = hf;
  const out = new ImageData(w, h);
  let mn = Infinity;
  let mx = -Infinity;
  for (const v of z) {
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  const range = Math.max(mx - mn, 1e-9);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const xl = z[y * w + Math.max(0, x - 1)];
      const xr = z[y * w + Math.min(w - 1, x + 1)];
      const yu = z[Math.max(0, y - 1) * w + x];
      const yd = z[Math.min(h - 1, y + 1) * w + x];
      const gx = (xr - xl) / range;
      const gy = (yd - yu) / range;
      const shade = 0.5 + 0.5 * (gx * Math.cos(lightAzimuth) + gy * Math.sin(lightAzimuth)) * 6;
      const t = (z[i] - mn) / range;
      const [r, g, b] = viridis(t);
      const k = Math.min(1.4, Math.max(0.3, shade));
      const p = i * 4;
      out.data[p] = Math.min(255, r * k);
      out.data[p + 1] = Math.min(255, g * k);
      out.data[p + 2] = Math.min(255, b * k);
      out.data[p + 3] = 255;
    }
  }
  return out;
}

/** 粗糙度网格 → 彩色格子 ImageData（R 越高越暖） */
export function rugosityGridToImageData(report: RugosityReport, cellW: number, cellH: number): ImageData {
  const out = new ImageData(cellW, cellH);
  let mn = Infinity;
  let mx = -Infinity;
  for (const c of report.cells) {
    mn = Math.min(mn, c.rugosity);
    mx = Math.max(mx, c.rugosity);
  }
  const range = Math.max(mx - mn, 1e-9);
  const pxW = cellW / report.cols;
  const pxH = cellH / report.rows;
  for (const c of report.cells) {
    const t = (c.rugosity - mn) / range;
    const [r, g, b] = viridis(t);
    const x0 = Math.floor(c.col * pxW);
    const x1 = Math.floor((c.col + 1) * pxW);
    const y0 = Math.floor(c.row * pxH);
    const y1 = Math.floor((c.row + 1) * pxH);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const p = (y * cellW + x) * 4;
        out.data[p] = r;
        out.data[p + 1] = g;
        out.data[p + 2] = b;
        out.data[p + 3] = 200;
      }
    }
  }
  return out;
}

/** ImageData 画到指定尺寸 canvas */
export function imageDataToCanvas(img: ImageData, scale = 1): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.width * scale));
  c.height = Math.max(1, Math.round(img.height * scale));
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.putImageData(img, 0, 0);
  if (scale !== 1) {
    const tmp = c;
    const c2 = document.createElement('canvas');
    c2.width = c.width;
    c2.height = c.height;
    c2.getContext('2d')!.drawImage(tmp, 0, 0);
    return c2;
  }
  return c;
}

/** 剖面曲线 SVG（高度场第 rowFrac 行的横向剖面） */
export function profileSvg(hf: HeightField, rowFrac: number, width = 520, height = 150): string {
  const row = Math.min(hf.height - 1, Math.max(0, Math.floor(rowFrac * hf.height)));
  let mn = Infinity;
  let mx = -Infinity;
  for (const v of hf.z) {
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  const range = Math.max(mx - mn, 1e-9);
  const pts: string[] = [];
  const pad = 8;
  for (let x = 0; x < hf.width; x++) {
    const v = hf.z[row * hf.width + x];
    const px = pad + (x / (hf.width - 1)) * (width - 2 * pad);
    const py = height - pad - ((v - mn) / range) * (height - 2 * pad);
    pts.push(`${px.toFixed(1)},${py.toFixed(1)}`);
  }
  return `<svg class="svg-chart" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${width}" height="${height}" fill="#071018" rx="8"/>
    <polyline points="${pts.join(' ')}" fill="none" stroke="#38b6a8" stroke-width="1.6"/>
    <text x="${pad}" y="18" fill="#8fa9bd" font-size="11">横向剖面 y=${(rowFrac * 100).toFixed(0)}%  高程 ${mn.toFixed(2)}~${mx.toFixed(2)} m</text>
  </svg>`;
}
