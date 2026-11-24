/**
 * 评估运行器：把合成图或上传照片跑完整管线，产出 Assessment 并落库。
 */
import type { FloatImage } from './types';
import { processOnCPU, processOnGPU } from './processing';
import type { ProcessResult } from './processing';
import { getGPU } from '../webgl/context';
import type { Assessment, RugosityCellDTO, Transect } from '../state/model';
import { store } from '../state/store';
import { uid } from '../state/db';

export interface RunOptions {
  image: FloatImage;
  physicalWidthM: number;
  physicalHeightM: number;
  maxLongEdge?: number;
  measuredR?: number;
  groundTruthR?: number;
  backend?: 'webgl2' | 'cpu';
}

export function toAssessment(r: ProcessResult, opts: RunOptions): Assessment {
  const cells: RugosityCellDTO[] = r.rugosity.cells.map((c) => ({
    col: c.col,
    row: c.row,
    rugosity: c.rugosity,
    rugosityX: c.rugosityX,
    rugosityY: c.rugosityY,
  }));
  const reference = opts.groundTruthR ?? opts.measuredR;
  const errorPct = reference !== undefined
    ? Math.abs(r.rugosity.mean - reference) / reference * 100
    : undefined;
  return {
    id: uid(),
    createdAt: new Date().toISOString(),
    backend: r.backend,
    workingWidth: r.workingWidth,
    workingHeight: r.workingHeight,
    physicalWidthM: opts.physicalWidthM,
    scale: r.scale,
    meanR: r.rugosity.mean,
    stdR: r.rugosity.std,
    measuredR: opts.measuredR,
    errorPct,
    cells,
    gridCols: r.rugosity.cols,
    gridRows: r.rugosity.rows,
    totalMs: r.totalMs,
    timings: r.timings,
  };
}

export function runAssessment(opts: RunOptions): ProcessResult {
  const backend = opts.backend ?? 'webgl2';
  const input = {
    image: opts.image,
    physicalWidthM: opts.physicalWidthM,
    maxLongEdge: opts.maxLongEdge,
    measuredR: opts.measuredR ?? opts.groundTruthR,
  };
  if (backend === 'cpu') return processOnCPU(input);
  try {
    const gpu = getGPU();
    return processOnGPU(gpu, input);
  } catch (e) {
    console.warn('GPU 管线失败，回退 CPU：', e);
    return processOnCPU(input);
  }
}

export async function persistAssessment(
  partial: Omit<Transect, 'id' | 'createdAt' | 'updatedAt'>,
  assessment: Assessment,
): Promise<Transect> {
  const now = new Date().toISOString();
  const transect: Transect = {
    ...partial,
    id: uid(),
    assessment,
    createdAt: now,
    updatedAt: now,
  };
  await store.save(transect);
  return transect;
}
