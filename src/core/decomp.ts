/**
 * 光照 / 反照分层（intrinsic decomposition），CPU 参考实现。
 *
 * 观测图像 I = A · L（反照率 × 光照）。在对数域：
 *   1) 梯度域 Horn Retinex 求亮度光照 logL：小梯度归光照、大梯度（反照边缘）
 *      让给反照，Poisson 积分 + White-Patch(p99) 锚定。深色珊瑚这种大片暗区
 *      因边界梯度被划给反照，光照在其上保持典型水平，不会被当成光照暗坑；
 *   2) 水下光照近似无空间色度变化，每通道 log 光照 = logL + 恒定通道偏移；
 *   3) 焦散 = 正残差（鲁棒 MAD 阈值）+ 低饱和联合检出，能量从反照移除、
 *      光照层邻域填补（"焦散留在光照层里扔掉"）；
 *   4) 阴影 = 去焦散光照低百分位暗区，输出置信度掩膜供 SFS 降权。
 *
 * 同数学的 GLSL 实现见 src/glsl/retinex_*.fs 与 decomp.fs。
 */
import { DECOMP } from './types';
import type { DecompResult, FloatImage } from './types';
import {
  boxBlur,
  dilate,
  inpaintMasked,
  luminance,
  percentile,
  saturation,
} from './geometry';
import { retinexIllumination } from './retinex';

const EPS = 1e-4;

function mad(arr: Float32Array): { med: number; mad: number } {
  const sorted = Float32Array.from(arr).sort();
  const med = percentile(sorted, 0.5);
  const dev = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) dev[i] = Math.abs(arr[i] - med);
  const devSorted = Float32Array.from(dev).sort();
  return { med, mad: Math.max(percentile(devSorted, 0.5), 1e-4) };
}

export function decompose(img: FloatImage): DecompResult {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const radius = Math.max(2, Math.round(Math.min(w, h) * DECOMP.baseRadiusFrac));

  const L = luminance(img);
  const S = saturation(img);
  const logLum = new Float32Array(n);
  for (let i = 0; i < n; i++) logLum[i] = Math.log(L[i] + EPS);

  // 1) 梯度域 Retinex → 锚定后的亮度 log 光照
  const initGuide = boxBlur(logLum, w, h, radius);
  const logBase = retinexIllumination(logLum, initGuide, w, h, {
    iterations: DECOMP.retinexIters,
    edgeThreshold: DECOMP.retinexEdgeThresh,
  });
  const residual = new Float32Array(n);
  for (let i = 0; i < n; i++) residual[i] = logLum[i] - logBase[i];

  // 2) 焦散检出：正残差（鲁棒 MAD 阈值）且低饱和
  const { med, mad: m } = mad(residual);
  const causticRaw = new Float32Array(n);
  const causticThresh = med + DECOMP.causticMadK * m;
  for (let i = 0; i < n; i++) {
    const bright = residual[i] > causticThresh ? 1 : 0;
    const lowSat = S[i] < DECOMP.causticSatMax ? 1 : 0;
    causticRaw[i] = bright * lowSat;
  }
  const causticMask = dilate(causticRaw, w, h, DECOMP.causticFillRadius);

  // 3) 去焦散：光照基底在掩膜处用邻域非焦散值修复
  const logBaseClean = inpaintMasked(logBase, causticMask, w, h, DECOMP.causticFillRadius * 2);

  // 4) 通道恒定偏移，与 White-Patch 锚定同口径（p99 对 p99），
  // 避免占画面主体的暗珊瑚用全局均值把偏移拉低
  const sortedBase = Float32Array.from(logBaseClean).sort();
  const baseP99 = percentile(sortedBase, 0.99);
  const offsets = new Float32Array(3);
  for (let c = 0; c < 3; c++) {
    const logC = new Float32Array(n);
    for (let i = 0; i < n; i++) logC[i] = Math.log(data[i * 3 + c] + EPS);
    const sortedC = Float32Array.from(logC).sort();
    offsets[c] = percentile(sortedC, 0.99) - baseP99;
  }

  const albedo = new Float32Array(n * 3);
  const illumination = new Float32Array(n * 3);
  const illumChannels: Float32Array[] = [];
  for (let c = 0; c < 3; c++) {
    const ill = new Float32Array(n);
    for (let i = 0; i < n; i++) ill[i] = Math.exp(logBaseClean[i] + offsets[c]);
    illumChannels.push(ill);
  }

  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      illumination[i * 3 + c] = illumChannels[c][i];
      albedo[i * 3 + c] = data[i * 3 + c] / (illumChannels[c][i] + EPS);
    }
  }
  // 反照焦散像素：邻域非焦散反照按通道修复
  for (let c = 0; c < 3; c++) {
    const ch = new Float32Array(n);
    for (let i = 0; i < n; i++) ch[i] = albedo[i * 3 + c];
    const fixed = inpaintMasked(ch, causticMask, w, h, DECOMP.causticFillRadius * 2);
    for (let i = 0; i < n; i++) albedo[i * 3 + c] = Math.min(1.2, fixed[i]);
  }

  // 5) 阴影掩膜：相对光照中位数的比例判定，随实际动态范围自适应，
  //    避免窄光照范围下绝对阈值把全场误判成阴影。
  const illumLum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    illumLum[i] = Math.exp(logBaseClean[i]);
  }
  const sortedLum = Float32Array.from(illumLum).sort();
  const medLum = percentile(sortedLum, 0.5);
  // 阴影暗端/亮端 = 中位数的比例
  const pLo = medLum * DECOMP.shadowLoRatio;
  const pHi = medLum * DECOMP.shadowHiRatio;
  const shadowMask = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = illumLum[i];
    shadowMask[i] = v >= pHi ? 0 : v <= pLo ? 1 : (pHi - v) / (pHi - pLo);
  }

  const ambient: [number, number, number] = [
    medLum * DECOMP.shadowLoRatio,
    medLum * DECOMP.shadowLoRatio,
    medLum * DECOMP.shadowLoRatio,
  ];

  return {
    width: w,
    height: h,
    albedo: { width: w, height: h, data: albedo },
    illumination: { width: w, height: h, data: illumination },
    causticMask,
    shadowMask,
    ambient,
  };
}
