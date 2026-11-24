/**
 * 梯度域 Horn Retinex 光照/反照分解。
 *
 * 观测模型（对数域）：i = a + l。
 * 物理先验：
 *   - 光照 l 空间平滑，只含小梯度（阴影缓变、环境光缓变）；
 *   - 反照 a 分片常数，其变化集中在大梯度边缘（深色珊瑚边界、沙沟、群落分界）。
 *
 * 做法（Horn 1974）：
 *   1. 求观测对数图梯度 g = ∇i；
 *   2. 光照梯度 = g · w_edge，w_edge 在大梯度处→0（边缘让给反照）；
 *   3. Poisson 积分 Δl = div(g·w)，雅可比迭代，均值锚定 mean(l)=mean(i)。
 *
 * 关键性质：均匀暗珊瑚内部梯度≈0，其边界大梯度被完全划给反照，
 * 光照在边界不跳变、内部维持外部典型光照水平 —— 深色珊瑚因此稳定落入反照层，
 * 不会被后续明暗恢复误判成凹坑。
 */

export interface RetinexOptions {
  iterations: number;
  /** 边缘判定梯度阈值（对数域），|g| 大于它视为反照边缘 */
  edgeThreshold: number;
}

export function retinexIllumination(
  logImg: Float32Array,
  _guide: Float32Array,
  w: number,
  h: number,
  opts: RetinexOptions,
): Float32Array {
  const n = w * h;
  const { iterations, edgeThreshold } = opts;

  // 1) 观测前向梯度
  const gx = new Float32Array(n);
  const gy = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const xr = x < w - 1 ? i + 1 : i;
      const yd = y < h - 1 ? i + w : i;
      gx[i] = logImg[xr] - logImg[i];
      gy[i] = logImg[yd] - logImg[i];
    }
  }

  // 2) 光照梯度 = 观测梯度 × 边缘权重（大梯度置零，归反照）
  const lx = new Float32Array(n);
  const ly = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const wx = Math.exp(-Math.pow(Math.abs(gx[i]) / edgeThreshold, 2));
    const wy = Math.exp(-Math.pow(Math.abs(gy[i]) / edgeThreshold, 2));
    lx[i] = gx[i] * wx;
    ly[i] = gy[i] * wy;
  }

  // 3) 散度 rhs = div(lx, ly)
  const rhs = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const lxL = x > 0 ? lx[i - 1] : 0;
      const lyU = y > 0 ? ly[i - w] : 0;
      rhs[i] = (lx[i] - lxL) + (ly[i] - lyU);
    }
  }

  // 4) Poisson 雅可比求解 Δl = rhs，Neumann 边界
  let l = new Float32Array(n);
  // White-Patch 锚定（p99）：光照对数对齐观测高百分位，
  // 既让大面积暗珊瑚无法把光照基准拉低，又对孤立高光/焦散亮纹鲁棒
  const sorted = Array.from(logImg).sort((a, b) => a - b);
  const anchor = sorted[Math.min(n - 1, Math.floor(n * 0.99))];
  for (let it = 0; it < iterations; it++) {
    const ln = new Float32Array(n);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const xl = x > 0 ? l[i - 1] : l[i];
        const xr = x < w - 1 ? l[i + 1] : l[i];
        const yu = y > 0 ? l[i - w] : l[i];
        const yd = y < h - 1 ? l[i + w] : l[i];
        ln[i] = (xl + xr + yu + yd - rhs[i]) / 4;
      }
    }
    // p99 锚定
    const lnSorted = Array.from(ln).sort((a, b) => a - b);
    const curP = lnSorted[Math.min(n - 1, Math.floor(n * 0.99))];
    const shift = anchor - curP;
    for (let i = 0; i < n; i++) ln[i] += shift;
    l = ln;
  }
  return l;
}
