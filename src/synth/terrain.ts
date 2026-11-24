/**
 * 礁体起伏高度场模型（合成测试用），高度单位为米。
 * 四类模型覆盖甲方关心的形态：
 *   massive  块状珊瑚：圆缓丘体 + 微起伏，深色反照（不能被误判为凹坑）；
 *   branching 枝状珊瑚：密集细脊/细柱，起伏细碎且阴影窄而深；
 *   mixed    混合礁体：块状丘 + 枝丛斑块 + 沙沟；
 *   flat     近平坦沙底：低幅粗糙，作为粗糙度下限对照。
 */
import { fbm, hash2 } from './noise';

export type TerrainKind = 'massive' | 'branching' | 'mixed' | 'flat';

export interface TerrainModel {
  kind: TerrainKind;
  width: number;
  height: number;
  /** 物理覆盖宽度（米） */
  physicalWidthM: number;
  /** 高度场（米），行优先 */
  z: Float32Array;
  /** 反照率 RGB 0..1 交错 */
  albedo: Float32Array;
  pixelSize: number;
}

interface Blob {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  amp: number;
}

function makeBlobs(w: number, h: number, count: number, seed: number, ampRange: [number, number]): Blob[] {
  const blobs: Blob[] = [];
  for (let i = 0; i < count; i++) {
    blobs.push({
      cx: hash2(i, 1, seed) * w,
      cy: hash2(i, 2, seed) * h,
      rx: (0.06 + hash2(i, 3, seed) * 0.12) * w,
      ry: (0.06 + hash2(i, 4, seed) * 0.12) * h,
      amp: ampRange[0] + hash2(i, 5, seed) * (ampRange[1] - ampRange[0]),
    });
  }
  return blobs;
}

export function generateTerrain(
  kind: TerrainKind,
  width: number,
  height: number,
  physicalWidthM = 10,
  seed = 7,
): TerrainModel {
  const z = new Float32Array(width * height);
  const albedo = new Float32Array(width * height * 3);
  const pixelSize = physicalWidthM / width;
  const scale = 8 / width; // 噪声空间尺度

  const massiveBlobs = makeBlobs(width, height, 14, seed + 11, [0.35, 0.9]);
  const branchBlobs = makeBlobs(width, height, 26, seed + 23, [0.18, 0.45]);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const nx = x * scale;
      const ny = y * scale;
      let heightM = 0;

      if (kind === 'flat') {
        heightM = 0.05 * (fbm(nx, ny, seed, 4) - 0.5);
      } else if (kind === 'massive') {
        let hh = 0;
        for (const b of massiveBlobs) {
          const dx = (x - b.cx) / b.rx;
          const dy = (y - b.cy) / b.ry;
          hh += b.amp * Math.exp(-(dx * dx + dy * dy) * 1.6);
        }
        heightM = hh + 0.08 * (fbm(nx, ny, seed, 4) - 0.5);
      } else if (kind === 'branching') {
        // 高频脊柱：多个窄高斯 + 强 fbm 切割
        let hh = 0;
        for (const b of branchBlobs) {
          const dx = (x - b.cx) / (b.rx * 0.45);
          const dy = (y - b.cy) / (b.ry * 0.45);
          hh += b.amp * Math.exp(-(dx * dx + dy * dy) * 2.2);
        }
        const ridge = 1 - Math.abs(2 * fbm(nx * 2.2, ny * 2.2, seed + 5, 4) - 1);
        heightM = hh + 0.35 * ridge + 0.05 * (fbm(nx, ny, seed + 9, 3) - 0.5);
      } else {
        // mixed：左半块状、右半枝丛，中间一条沙沟
        let hh = 0;
        for (const b of massiveBlobs) {
          const dx = (x - b.cx * 0.7) / b.rx;
          const dy = (y - b.cy) / b.ry;
          hh += b.amp * 0.8 * Math.exp(-(dx * dx + dy * dy) * 1.6);
        }
        for (const b of branchBlobs) {
          const dx = (x - (width * 0.55 + b.cx * 0.5)) / (b.rx * 0.5);
          const dy = (y - b.cy) / (b.ry * 0.5);
          hh += b.amp * Math.exp(-(dx * dx + dy * dy) * 2.2);
        }
        const grooveX = (x - width * 0.5) / (width * 0.03);
        const groove = Math.exp(-Math.pow(grooveX, 2)) * 0.35;
        const ridge = 1 - Math.abs(2 * fbm(nx * 2, ny * 2, seed + 5, 4) - 1);
        heightM = hh + 0.18 * ridge - groove + 0.06 * (fbm(nx, ny, seed, 4) - 0.5);
      }

      z[idx] = Math.max(0, heightM);

      // 反照：块状/枝状珊瑚偏深褐，沙底偏亮；深色块专门考验"别当成凹坑"
      const n = fbm(nx * 3, ny * 3, seed + 31, 3);
      // 低频色相变化：不同珊瑚群落色相不同（真实礁体特征，也是分层的关键线索）
      const hue = fbm(nx * 0.8, ny * 0.8, seed + 57, 3);
      let r: number, g: number, b: number;
      if (kind === 'flat') {
        r = 0.62 + 0.1 * n;
        g = 0.58 + 0.09 * n;
        b = 0.45 + 0.08 * n;
      } else {
        // 深褐珊瑚体（低反照），叠加零星亮色珊瑚息肉
        const polyp = fbm(nx * 12, ny * 12, seed + 41, 2) > 0.72 ? 1 : 0;
        const base = 0.16 + 0.1 * n + 0.22 * polyp;
        // 色相随群落变化：红褐 ↔ 橄榄绿 ↔ 暗紫棕，保持整体低反照
        const hueR = 1.05 + 0.35 * (hue - 0.5);
        const hueG = 0.85 + 0.45 * hue;
        const hueB = 0.7 + 0.4 * (1 - hue);
        r = base * hueR;
        g = base * hueG;
        b = base * hueB;
        if (kind === 'mixed' && Math.abs(x - width * 0.5) < width * 0.04) {
          r = 0.6; g = 0.56; b = 0.44; // 沙沟亮色
        }
      }
      albedo[idx * 3] = r;
      albedo[idx * 3 + 1] = g;
      albedo[idx * 3 + 2] = b;
    }
  }

  return { kind, width, height, physicalWidthM, z, albedo, pixelSize };
}
