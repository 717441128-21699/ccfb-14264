import type { FloatImage, HeightField, RugosityCell, RugosityReport } from './types';
import { CHAIN_LINK_M } from './types';

/* ---------------- 基础图像工具 ---------------- */

export function lumOf(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function luminance(img: FloatImage): Float32Array {
  const out = new Float32Array(img.width * img.height);
  const d = img.data;
  for (let i = 0, p = 0; i < d.length; i += 3, p++) {
    out[p] = lumOf(d[i], d[i + 1], d[i + 2]);
  }
  return out;
}

export function saturation(img: FloatImage): Float32Array {
  const out = new Float32Array(img.width * img.height);
  const d = img.data;
  for (let i = 0, p = 0; i < d.length; i += 3, p++) {
    const mx = Math.max(d[i], d[i + 1], d[i + 2]);
    const mn = Math.min(d[i], d[i + 1], d[i + 2]);
    out[p] = mx > 1e-6 ? (mx - mn) / mx : 0;
  }
  return out;
}

/** 盒式均值模糊（半径 r，边缘 clamp），CPU 参考实现 */
export function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const norm = 2 * r + 1;
  // 横向
  for (let y = 0; y < h; y++) {
    let acc = 0;
    const row = y * w;
    for (let x = -r; x <= r; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / norm;
      const xa = Math.min(w - 1, Math.max(0, x - r));
      const xb = Math.min(w - 1, Math.max(0, x + r + 1));
      acc += src[row + xb] - src[row + xa];
    }
  }
  // 纵向
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / norm;
      const ya = Math.min(h - 1, Math.max(0, y - r));
      const yb = Math.min(h - 1, Math.max(0, y + r + 1));
      acc += tmp[yb * w + x] - tmp[ya * w + x];
    }
  }
  return out;
}

/** 面积降采样（2x2 均值） */
export function downsample2(src: Float32Array, w: number, h: number): {
  data: Float32Array;
  width: number;
  height: number;
} {
  const nw = Math.max(1, w >> 1);
  const nh = Math.max(1, h >> 1);
  const out = new Float32Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const sx = x * 2;
      const sy = y * 2;
      let sum = 0;
      let n = 0;
      for (let dy = 0; dy < 2 && sy + dy < h; dy++) {
        for (let dx = 0; dx < 2 && sx + dx < w; dx++) {
          sum += src[(sy + dy) * w + sx + dx];
          n++;
        }
      }
      out[y * nw + x] = sum / n;
    }
  }
  return { data: out, width: nw, height: nh };
}

/** 双线性放大到目标尺寸 */
export function upsampleBilinear(src: Float32Array, sw: number, sh: number, dw: number, dh: number): Float32Array {
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const fy = (y + 0.5) * sh / dh - 0.5;
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    const cy0 = Math.min(sh - 1, Math.max(0, y0));
    const cy1 = Math.min(sh - 1, Math.max(0, y0 + 1));
    for (let x = 0; x < dw; x++) {
      const fx = (x + 0.5) * sw / dw - 0.5;
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      const cx0 = Math.min(sw - 1, Math.max(0, x0));
      const cx1 = Math.min(sw - 1, Math.max(0, x0 + 1));
      const a = src[cy0 * sw + cx0];
      const b = src[cy0 * sw + cx1];
      const c = src[cy1 * sw + cx0];
      const d = src[cy1 * sw + cx1];
      out[y * dw + x] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    }
  }
  return out;
}

/** 鲁棒中位数（用于百分位/环境项） */
export function percentile(sortedView: ArrayLike<number>, p: number): number {
  const idx = Math.min(sortedView.length - 1, Math.max(0, Math.round(p * (sortedView.length - 1))));
  return sortedView[idx];
}

/** 圆形结构元素膨胀（半径 r），二值/软掩膜通用（取邻域最大值） */
export function dilate(mask: Float32Array, w: number, h: number, r: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let dy = -r; dy <= r; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy > r * r) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const v = mask[ny * w + nx];
          if (v > m) m = v;
        }
      }
      out[y * w + x] = m;
    }
  }
  return out;
}

/** 掩膜内像素用邻域非掩膜均值填补（一轮扩散，CPU 参考够用） */
export function inpaintMasked(src: Float32Array, mask: Float32Array, w: number, h: number, r: number): Float32Array {
  const out = src.slice();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (mask[idx] < 0.5) continue;
      let sum = 0;
      let n = 0;
      for (let dy = -r; dy <= r; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const ni = ny * w + nx;
          if (mask[ni] >= 0.5) continue;
          sum += src[ni];
          n++;
        }
      }
      if (n > 0) out[idx] = sum / n;
    }
  }
  return out;
}

/* ---------------- 高度场几何 ---------------- */

export function hfAt(hf: HeightField, x: number, y: number): number {
  const cx = Math.min(hf.width - 1, Math.max(0, x));
  const cy = Math.min(hf.height - 1, Math.max(0, y));
  return hf.z[cy * hf.width + cx];
}

/** 高度场双线性插值（fx/fy 为像素坐标，像素中心在整数 +0.5 由调用方换算） */
function bilinearZ(hf: HeightField, fx: number, fy: number): number {
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const x1 = Math.min(hf.width - 1, x0 + 1);
  const y1 = Math.min(hf.height - 1, y0 + 1);
  const cx0 = Math.min(hf.width - 1, Math.max(0, x0));
  const cy0 = Math.min(hf.height - 1, Math.max(0, y0));
  const a = hf.z[cy0 * hf.width + cx0];
  const b = hf.z[cy0 * hf.width + x1];
  const c = hf.z[y1 * hf.width + cx0];
  const d = hf.z[y1 * hf.width + x1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

/**
 * 逐米网格粗糙度：在每个 1m × 1m 方格内沿行、列方向各跑一次离散链测，
 * R_cell = mean(Rx, Ry)。图像边缘不足 1m 的格子按实际宽度处理。
 */
export function rugosityGrid(hf: HeightField, cellM = 1): RugosityReport {
  const wM = hf.width * hf.pixelSize;
  const hM = hf.height * hf.pixelSize;
  const cols = Math.max(1, Math.round(wM / cellM));
  const rows = Math.max(1, Math.round(hM / cellM));
  const cells: RugosityCell[] = [];
  const rValues: number[] = [];

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x0 = (col * wM) / cols;
      const y0 = (row * hM) / rows;
      const cellW = wM / cols;
      const cellH = hM / rows;
      // 每个格子内沿中轴测两条链（横、纵）
      const rx = chainRugosityClean(hf, 'x', x0, y0 + cellH / 2, cellW);
      const ry = chainRugosityClean(hf, 'y', x0 + cellW / 2, y0, cellH);
      const rugosity = (rx + ry) / 2;
      cells.push({
        col,
        row,
        rugosity,
        rugosityX: rx,
        rugosityY: ry,
        links: Math.round(cellW / CHAIN_LINK_M) + Math.round(cellH / CHAIN_LINK_M),
      });
      rValues.push(rugosity);
    }
  }
  const mean = rValues.reduce((a, b) => a + b, 0) / rValues.length;
  const variance = rValues.reduce((a, b) => a + (b - mean) ** 2, 0) / rValues.length;
  return { cells, cols, rows, mean, std: Math.sqrt(variance) };
}

/**
 * 干净版一维链测：链节固定 link，沿表面逐节推进。
 * 每节从当前表面点出发，以 link 为半径与前方表面求交（二分），
 * 累计实际链长 = 节数 × link，R = 链长 / 水平长度。
 */
export function chainRugosityClean(hf: HeightField, axis: 'x' | 'y', startU: number, v: number, lengthM: number): number {
  const ps = hf.pixelSize;
  const link = CHAIN_LINK_M;
  const surfaceAt = (u: number): number => {
    const fx = (axis === 'x' ? u : v) / ps - 0.5;
    const fy = (axis === 'x' ? v : u) / ps - 0.5;
    return bilinearZ(hf, fx, fy);
  };

  let u = startU;
  let z = surfaceAt(u);
  let chain = 0;
  const end = startU + lengthM;
  let guard = 0;
  while (u < end - 1e-9 && guard++ < 1e6) {
    const remain = end - u;
    // 在 [u, u+link] 内找满足弦长 = link 的最远表面点
    let lo = 0;
    let hi = Math.min(link, remain);
    for (let it = 0; it < 24; it++) {
      const mid = (lo + hi) / 2;
      const zm = surfaceAt(u + mid);
      const chord = Math.hypot(mid, zm - z);
      if (chord < link) lo = mid;
      else hi = mid;
    }
    const stepU = (lo + hi) / 2;
    const stepZ = surfaceAt(u + stepU);
    const actual = Math.hypot(stepU, stepZ - z);
    chain += actual;
    u += stepU;
    z = stepZ;
    if (actual < 1e-9) break;
  }
  return chain / lengthM;
}

/** 整条样带平均 R（所有中线扫描链的均值），作为标定与快速比对用 */
export function meanRugosity(hf: HeightField, samples: number): number {
  const wM = hf.width * hf.pixelSize;
  const hM = hf.height * hf.pixelSize;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const v = ((i + 0.5) / samples) * hM;
    sum += chainRugosityClean(hf, 'x', 0, v, wM);
  }
  return sum / samples;
}
