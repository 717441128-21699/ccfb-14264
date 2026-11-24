/**
 * 程序化水面焦散图案。
 * 思路：两层错位 Voronoi 胞体网络取亮脊（焦散网络是水面折射会聚线），
 * 叠加高频闪烁并做指数增益，得到与实拍浅水照片同构的亮纹。
 * 输出 0..1 单通道，1 = 强焦散。
 */
import { hash2 } from './noise';

function voronoiEdge(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let minD = 8;
  let secondD = 8;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = ix + dx + hash2(ix + dx, iy + dy, seed);
      const cy = iy + dy + hash2(ix + dx, iy + dy, seed + 999);
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (d < minD) {
        secondD = minD;
        minD = d;
      } else if (d < secondD) {
        secondD = d;
      }
    }
  }
  // 到最近/次近胞体距离差 → 边缘亮脊
  return Math.sqrt(secondD) - Math.sqrt(minD);
}

export function causticField(x: number, y: number, t: number, seed: number): number {
  const s = 3.2;
  const wobble = 0.35;
  const e1 = voronoiEdge(x * s + Math.sin(t * 0.7 + y) * wobble, y * s + Math.cos(t * 0.6 + x) * wobble, seed);
  const e2 = voronoiEdge(x * s * 1.7 - t * 0.15, y * s * 1.7 + t * 0.12, seed + 17);
  const edge = Math.min(e1, e2 * 1.2);
  // 亮脊：距离差越小越亮
  let v = 1 - Math.min(1, edge / 0.18);
  v = v * v;
  // 网络内闪烁
  const flicker = 0.85 + 0.3 * Math.sin(x * 9 + t * 2.1) * Math.cos(y * 8 - t * 1.7);
  v *= flicker;
  return Math.max(0, Math.min(1, v));
}

export function renderCausticLayer(width: number, height: number, time: number, seed: number): Float32Array {
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / width;
      const v = y / height;
      // 保持宽高比的世界坐标
      out[y * width + x] = causticField(u, v * (height / width), time, seed);
    }
  }
  return out;
}
