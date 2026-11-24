/**
 * 全局共享常量与类型。
 * CPU 参考实现（src/core）与 GLSL（src/glsl）必须使用同一组参数，
 * 以保证 GPU/CPU 一致性测试可直接比对。
 */

/** 光照方向（相机坐标系：z 轴指向礁面外，光从左上前方入射） */
export const LIGHT = { x: -0.36, y: -0.27, z: 0.894 };

/** 分层参数 */
export const DECOMP = {
  /** 引导滤波大半径（像素，按短边比例另算），用于提取平缓光照基底 */
  baseRadiusFrac: 0.045,
  /** 引导滤波正则项（按引导信号功率归一化），越小越能保住反照硬边缘 */
  guidedEps: 0.00035,
  /** 盒式模糊半径（构建均值金字塔用，每级） */
  boxRadius: 2,
  /** 焦散判定：对数域正残差的鲁棒阈值（k × MAD） */
  causticMadK: 3.2,
  /** 焦散判定：低饱和度阈值 */
  causticSatMax: 0.35,
  /** 焦散掩膜膨胀/填补半径（像素） */
  causticFillRadius: 2,
  /** Retinex Poisson 雅可比迭代次数 */
  retinexIters: 40,
  /** Retinex 边缘梯度阈值（对数域）：高于它视为反照边缘让给反照层 */
  retinexEdgeThresh: 0.15,
  /** 阴影暗端 = 光照中位数 × 该比例 */
  shadowLoRatio: 0.72,
  /** 阴影亮端（过渡带边界）= 光照中位数 × 该比例 */
  shadowHiRatio: 0.9,
  /** 环境光照估计百分位（取光照图该百分位作为环境项） */
  ambientPercentile: 0.12,
} as const;

/** 明暗恢复（SFS）参数 */
export const SFS = {
  /** 金字塔级数（最粗边长约 longEdge / 2^(levels-1)） */
  levels: 4,
  /** 每级迭代次数（GPU 并行收敛快，CPU 测试同口径） */
  itersPerLevel: 12,
  /** 每次梯度投影后的 Jacobi 积分次数（CPU/GPU 同数学） */
  jacobiPerGrad: 4,
  /** Horn 迭代步长 */
  step: 0.24,
  /** 阴影区数据项权重（扩散填补，不让阴影产生深坑） */
  shadowWeight: 0.08,
  /** 坡度钳制（|p|,|q| 上限，防焦散残余放大） */
  slopeClamp: 2.2,
  /** 漫反射环境项下限 */
  ambientFloor: 0.04,
} as const;

/** 离散链测法链节长度（米） */
export const CHAIN_LINK_M = 0.02;

export interface FloatImage {
  width: number;
  height: number;
  /** RGB 交错，取值 0..1 */
  data: Float32Array;
}

export interface HeightField {
  width: number;
  height: number;
  /** 高度（米），行优先 */
  z: Float32Array;
  /** 像素覆盖的地面尺寸（米/像素） */
  pixelSize: number;
}

export interface DecompResult {
  width: number;
  height: number;
  /** 反照率 RGB 0..1（焦散能量已移除） */
  albedo: FloatImage;
  /** 去焦散后的平缓光照 RGB 0..1 */
  illumination: FloatImage;
  /** 焦散掩膜 0..1（1 = 焦散像素） */
  causticMask: Float32Array;
  /** 阴影掩膜 0..1（1 = 阴影像素） */
  shadowMask: Float32Array;
  /** 环境光照项（每通道） */
  ambient: [number, number, number];
}

export interface RugosityCell {
  /** 网格列/行（从 0 开始） */
  col: number;
  row: number;
  /** 粗糙度指数 R = 链长 / 水平距离，行、列两个方向均值 */
  rugosity: number;
  /** 行方向（横向）链测 R */
  rugosityX: number;
  /** 列方向（纵向）链测 R */
  rugosityY: number;
  /** 该格有效链节数 */
  links: number;
}

export interface RugosityReport {
  cells: RugosityCell[];
  cols: number;
  rows: number;
  /** 整条样带的平均 R */
  mean: number;
  std: number;
}
