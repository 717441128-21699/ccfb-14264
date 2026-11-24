/**
 * 多尺度 Horn 明暗恢复（Shape-from-Shading），CPU 参考实现。
 *
 * 输入为去焦散、去反照后的平缓光照（已近似为纯几何 shading），
 * 在朗伯体假设下由辐照度 E 反解表面梯度 (p, q)，再经变分迭代积分成高度场 z。
 *
 * 关键点（对应甲方要求）：
 *  - 输入只用光照层，颜色深的块状珊瑚在分层阶段已进入反照层，不会被当成凹坑；
 *  - 阴影像素数据项权重降为 shadowWeight，由平滑项扩散填补，阴影只形成平缓坡面；
 *  - 多尺度金字塔避免局部极小，坡度钳制抑制焦散残余造成的尖刺。
 *
 * 同数学的 GLSL 实现见 src/glsl/sfs.fs。
 */
import { LIGHT, SFS } from './types';
import type { DecompResult, HeightField } from './types';
import { luminance, downsample2, upsampleBilinear, meanRugosity } from './geometry';

const lx = LIGHT.x;
const ly = LIGHT.y;
const lz = LIGHT.z;

interface PyramidLevel {
  w: number;
  h: number;
  /** 归一化辐照度 0..1 */
  E: Float32Array;
  /** 每像素数据项置信度（阴影降权） */
  conf: Float32Array;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 由光照图构建归一化辐照度与置信度金字塔 */
function buildPyramid(decomp: DecompResult): PyramidLevel[] {
  const { width: w, height: h } = decomp;
  const lum = luminance(decomp.illumination);
  const n = w * h;
  // 环境项扣除 + 归一化：E ∈ [0,1]
  const amb = decomp.ambient;
  const ambLum = 0.2126 * amb[0] + 0.7152 * amb[1] + 0.0722 * amb[2];
  const E0 = new Float32Array(n);
  let maxE = 1e-3;
  for (let i = 0; i < n; i++) {
    E0[i] = clamp((lum[i] - ambLum) / (1 - ambLum), 0, 1);
    if (E0[i] > maxE) maxE = E0[i];
  }
  for (let i = 0; i < n; i++) E0[i] /= maxE;

  const conf0 = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    conf0[i] = 1 - (1 - SFS.shadowWeight) * decomp.shadowMask[i];
  }

  const levels: PyramidLevel[] = [{ w, h, E: E0, conf: conf0 }];
  for (let k = 1; k < SFS.levels; k++) {
    const prev = levels[k - 1];
    const eDs = downsample2(prev.E, prev.w, prev.h);
    const cDs = downsample2(prev.conf, prev.w, prev.h);
    levels.push({ w: eDs.width, h: eDs.height, E: eDs.data, conf: cDs.data });
  }
  return levels;
}

function divergence(p: Float32Array, q: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const pxL = x > 0 ? p[i - 1] : 0;
      const qyU = y > 0 ? q[i - w] : 0;
      out[i] = p[i] - pxL + (q[i] - qyU);
    }
  }
  return out;
}

/** 雅可比迭代求解 Δz = div(p,q) */
function integrateZ(p: Float32Array, q: Float32Array, w: number, h: number, iters: number, zInit?: Float32Array): Float32Array {
  let z = zInit ? zInit.slice() : new Float32Array(w * h);
  const rhs = divergence(p, q, w, h);
  for (let it = 0; it < iters; it++) {
    const zn = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const xl = x > 0 ? z[i - 1] : z[i];
        const xr = x < w - 1 ? z[i + 1] : z[i];
        const yu = y > 0 ? z[i - w] : z[i];
        const yd = y < h - 1 ? z[i + w] : z[i];
        zn[i] = (xl + xr + yu + yd - rhs[i]) / 4;
      }
    }
    let mean = 0;
    for (let i = 0; i < zn.length; i++) mean += zn[i];
    mean /= zn.length;
    for (let i = 0; i < zn.length; i++) zn[i] -= mean;
    z = zn;
  }
  return z;
}

/** 单级 Horn 迭代：辐照度约束更新 (p,q)，再积分 z */
function solveLevel(level: PyramidLevel, zInit: Float32Array | null): {
  z: Float32Array;
  p: Float32Array;
  q: Float32Array;
} {
  const { w, h, E, conf } = level;
  const n = w * h;
  let p = new Float32Array(n);
  let q = new Float32Array(n);
  let z = zInit ?? new Float32Array(n);

  for (let it = 0; it < SFS.itersPerLevel; it++) {
    const pNew = new Float32Array(n);
    const qNew = new Float32Array(n);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const xr = x < w - 1 ? z[i + 1] : z[i];
        const yd = y < h - 1 ? z[i + w] : z[i];
        const pz = xr - z[i];
        const qz = yd - z[i];
        // 朗伯反射率 R(p,q) = (lz - lx·p - ly·q) / sqrt(1+p²+q²)
        const denom = Math.sqrt(1 + pz * pz + qz * qz);
        const num = lz - lx * pz - ly * qz;
        const R = num / denom;
        const resid = (E[i] - R) * conf[i];
        // ∂R/∂p、∂R/∂q
        const dRdp = (-lx * denom - num * (pz / denom)) / (denom * denom);
        const dRdq = (-ly * denom - num * (qz / denom)) / (denom * denom);
        pNew[i] = clamp(pz + SFS.step * resid * dRdp, -SFS.slopeClamp, SFS.slopeClamp);
        qNew[i] = clamp(qz + SFS.step * resid * dRdq, -SFS.slopeClamp, SFS.slopeClamp);
      }
    }
    p = pNew;
    q = qNew;
    z = integrateZ(p, q, w, h, 4, z);
  }
  return { z, p, q };
}

/**
 * 恢复高度场。pixelSize = 样带物理宽度 / 图像宽度（米/像素）。
 */
export function shapeFromShading(decomp: DecompResult, pixelSize: number): HeightField {
  const pyramid = buildPyramid(decomp);
  let z: Float32Array | null = null;
  for (let k = pyramid.length - 1; k >= 0; k--) {
    const level = pyramid[k];
    if (z) {
      z = upsampleBilinear(z, pyramid[k + 1].w, pyramid[k + 1].h, level.w, level.h);
      for (let i = 0; i < z.length; i++) z[i] *= 2; // 粗→细尺度梯度校正
    }
    const solved = solveLevel(level, z);
    z = solved.z;
  }
  if (!z) throw new Error('SFS 金字塔求解失败：高度场为空');
  let mean = 0;
  for (let i = 0; i < z.length; i++) mean += z[i];
  mean /= z.length;
  for (let i = 0; i < z.length; i++) z[i] = (z[i] - mean) * pixelSize;
  return { width: decomp.width, height: decomp.height, z, pixelSize };
}

/**
 * 全局尺度标定：SFS 恢复高度仅差一个未知乘子。
 * 在候选尺度中取平均链测 R 与目标 R（野外实测或合成真值）最接近者。
 */
export function calibrateScale(
  hf: HeightField,
  targetR: number,
  scanSamples = 8,
): { scale: number; rugosity: number } {
  let bestScale = 1;
  let bestErr = Infinity;
  let bestR = 0;
  for (const s of [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 10, 12]) {
    const scaled: HeightField = { ...hf, z: scaleZ(hf.z, s) };
    const r = meanRugosity(scaled, scanSamples);
    const err = Math.abs(r - targetR);
    if (err < bestErr) {
      bestErr = err;
      bestScale = s;
      bestR = r;
    }
  }
  return { scale: bestScale, rugosity: bestR };
}

export function applyScale(hf: HeightField, scale: number): HeightField {
  return { ...hf, z: scaleZ(hf.z, scale) };
}

function scaleZ(z: Float32Array, s: number): Float32Array {
  const out = new Float32Array(z.length);
  for (let i = 0; i < z.length; i++) out[i] = z[i] * s;
  return out;
}
