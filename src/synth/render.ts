/**
 * 合成礁体照片渲染器（CPU，确定性）。
 *
 * 成像模型：I = A · (ambient + (1-阴影) · N·L) · (1 + k·焦散) · 水体色偏
 *  - 朗伯漫反射 + 环境项；阴影由高度场向光源方向步进做真实遮挡投射
 *    （枝状珊瑚阴影窄而深、块状阴影宽而缓，供阴影分类测试）；
 *  - 焦散以乘性亮纹叠加，低饱和、高明度，与实拍一致；
 *  - 块状珊瑚给低反照，验证深色珊瑚不会被 SFS 误判为凹坑。
 * 同时输出真值高度场与真值粗糙度，供 10% 误差门限测试。
 */
import { LIGHT } from '../core/types';
import type { FloatImage, HeightField } from '../core/types';
import { renderCausticLayer } from './caustic';
import type { TerrainModel } from './terrain';

export interface RenderOptions {
  causticStrength?: number;
  ambient?: number;
  time?: number;
  seed?: number;
  /** 水体蓝绿色偏强度 */
  waterTint?: number;
}

export interface RenderedScene {
  image: FloatImage;
  height: HeightField;
  groundTruthShadow: Float32Array;
  caustic: Float32Array;
}

function sampleZ(z: Float32Array, w: number, h: number, fx: number, fy: number): number {
  if (fx < 0 || fy < 0 || fx >= w - 1 || fy >= h - 1) return -1e9;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const a = z[y0 * w + x0];
  const b = z[y0 * w + x1];
  const c = z[y1 * w + x0];
  const d = z[y1 * w + x1];
  return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
}

/**
 * 高度场投射阴影：沿光源水平方向步进，若途中表面高于光线高度则在阴影中。
 * 光源高度角由 LIGHT 的 z 分量决定。
 */
export function castShadows(model: TerrainModel): Float32Array {
  const { width: w, height: h, z, pixelSize } = model;
  const shadow = new Float32Array(w * h);
  // 水平行进方向（朝光源）
  const hl = Math.hypot(LIGHT.x, LIGHT.y);
  const dx = -LIGHT.x / hl;
  const dy = -LIGHT.y / hl;
  const tanAlt = LIGHT.z / hl; // 高度角正切：光线每走水平 d，抬高 d·tanAlt
  const maxDist = Math.round(Math.hypot(w, h) * 0.6);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const z0 = z[i];
      let blocked = 0;
      for (let s = 2; s <= maxDist; s += 1) {
        const fx = x + dx * s;
        const fy = y + dy * s;
        if (fx < 0 || fy < 0 || fx >= w || fy >= h) break;
        const zSurf = sampleZ(z, w, h, fx, fy);
        const zRay = z0 + s * pixelSize * tanAlt;
        if (zSurf > zRay) {
          blocked = 1;
          break;
        }
      }
      shadow[i] = blocked;
    }
  }
  return shadow;
}

export function renderScene(model: TerrainModel, opts: RenderOptions = {}): RenderedScene {
  const {
    causticStrength = 0.55,
    ambient = 0.16,
    time = 1.3,
    seed = 7,
    waterTint = 0.18,
  } = opts;
  const { width: w, height: h, z, albedo, pixelSize } = model;
  const n = w * h;

  const shadow = castShadows(model);
  const caustic = renderCausticLayer(w, h, time, seed);

  const data = new Float32Array(n * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      // 法线由高度场中心差分
      const zl = sampleZ(z, w, h, x - 1, y);
      const zr = sampleZ(z, w, h, x + 1, y);
      const zu = sampleZ(z, w, h, x, y - 1);
      const zd = sampleZ(z, w, h, x, y + 1);
      const dzdx = (zr - zl) / (2 * pixelSize);
      const dzdy = (zd - zu) / (2 * pixelSize);
      // N = normalize(-dzdx, -dzdy, 1)
      let nx = -dzdx;
      let ny = -dzdy;
      let nz = 1;
      const nl = Math.hypot(nx, ny, nz);
      nx /= nl; ny /= nl; nz /= nl;
      const ndotl = Math.max(0, nx * LIGHT.x + ny * LIGHT.y + nz * LIGHT.z);
      const shade = ambient + (1 - ambient) * (1 - shadow[i]) * ndotl;
      const caust = 1 + causticStrength * caustic[i];

      for (let c = 0; c < 3; c++) {
        let v = albedo[i * 3 + c] * shade * caust;
        // 水体色偏：红通道衰减、蓝绿增强
        if (c === 0) v *= 1 - waterTint;
        if (c === 2) v *= 1 + waterTint * 0.7;
        data[i * 3 + c] = Math.max(0, Math.min(1, v));
      }
    }
  }

  return {
    image: { width: w, height: h, data },
    height: { width: w, height: h, z: z.slice(), pixelSize },
    groundTruthShadow: shadow,
    caustic,
  };
}
