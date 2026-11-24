/**
 * 领域模型：样带、年度记录、评估结果。
 */

export type TerrainKind = 'massive' | 'branching' | 'mixed' | 'flat' | 'field';

export interface RugosityCellDTO {
  col: number;
  row: number;
  rugosity: number;
  rugosityX: number;
  rugosityY: number;
}

export interface Assessment {
  id: string;
  createdAt: string;
  backend: 'webgl2' | 'cpu';
  workingWidth: number;
  workingHeight: number;
  physicalWidthM: number;
  scale: number;
  meanR: number;
  stdR: number;
  /** 链测法实测 R（若提供，用于标定） */
  measuredR?: number;
  /** 与实测/真值的相对误差（%） */
  errorPct?: number;
  cells: RugosityCellDTO[];
  gridCols: number;
  gridRows: number;
  totalMs: number;
  timings: Record<string, number>;
}

export interface Transect {
  id: string;
  name: string;
  site: string;
  year: number;
  terrain: TerrainKind;
  /** 样带物理尺寸（米） */
  widthM: number;
  heightM: number;
  /** 原始照片 Blob 键（IndexedDB 中） */
  photoKey?: string;
  thumbnailKey?: string;
  /** 合成图元信息（测试图） */
  synthetic?: {
    kind: string;
    seed: number;
    causticStrength: number;
    groundTruthR: number;
  };
  assessment?: Assessment;
  createdAt: string;
  updatedAt: string;
}

export interface YearStat {
  year: number;
  count: number;
  meanR: number;
  stdR: number;
  minR: number;
  maxR: number;
}
