/**
 * 端到端处理服务：把 WebGL2 管线、尺度标定、链测粗糙度串成一次评估，
 * 并记录各阶段耗时（用于 24MP / 4s 性能门限）。
 */
import type { DecompResult, FloatImage, HeightField, RugosityReport } from './types';
import { shapeFromShading, calibrateScale, applyScale } from './sfs';
import { rugosityGrid, meanRugosity } from './geometry';
import { downscaleImage } from './imageio';
import { decompose } from './decomp';
import { GPUPipeline } from '../webgl/pipeline';

export interface ProcessInput {
  image: FloatImage;
  /** 样带物理宽度（米），用于像素尺寸换算 */
  physicalWidthM: number;
  /** SFS 工作分辨率长边上限（0 = 用原图） */
  maxLongEdge?: number;
  /** 链测法实测平均 R（有则做尺度标定） */
  measuredR?: number;
}

export interface ProcessResult {
  decomp: DecompResult;
  height: HeightField;
  scaledHeight: HeightField;
  rugosity: RugosityReport;
  scale: number;
  workingWidth: number;
  workingHeight: number;
  timings: Record<string, number>;
  totalMs: number;
  backend: 'webgl2' | 'cpu';
}

export interface GLContext {
  gl: WebGL2RenderingContext;
  pipeline: GPUPipeline;
}

export function createGLContext(canvas: HTMLCanvasElement): GLContext {
  const gl = canvas.getContext('webgl2', {
    antialias: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  });
  if (!gl) throw new Error('当前浏览器不支持 WebGL2');
  const pipeline = new GPUPipeline(gl);
  return { gl, pipeline };
}

function now(): number {
  return performance.now();
}

/** GPU 主路径 */
export function processOnGPU(ctx: GLContext, input: ProcessInput): ProcessResult {
  const t0 = now();
  const work = input.maxLongEdge ? downscaleImage(input.image, input.maxLongEdge) : input.image;
  const tDown = now();
  const pixelSize = input.physicalWidthM / work.width;

  const srcTex = ctx.pipeline.uploadImage(work);
  const tUpload = now();
  const gpuDecomp = ctx.pipeline.decompose(srcTex, work.width, work.height);
  const tDecomp = now();
  const { zTex } = ctx.pipeline.runSFS(gpuDecomp);
  const tSfs = now();
  const height = ctx.pipeline.readHeight(zTex, work.width, work.height, pixelSize);
  const tRead = now();
  const decomp = ctx.pipeline.readDecomp(gpuDecomp);
  ctx.pipeline.destroyTexture(srcTex);
  ctx.pipeline.destroyTexture(gpuDecomp.albedo);
  ctx.pipeline.destroyTexture(gpuDecomp.illum);
  ctx.pipeline.destroyTexture(gpuDecomp.mask);
  ctx.pipeline.destroyTexture(zTex);

  const target = input.measuredR ?? estimateTargetR(height);
  const cal = calibrateScale(height, target, 8);
  const scaledHeight = applyScale(height, cal.scale);
  const tCal = now();
  const rugosity = rugosityGrid(scaledHeight, 1);
  const tRug = now();

  return {
    decomp,
    height,
    scaledHeight,
    rugosity,
    scale: cal.scale,
    workingWidth: work.width,
    workingHeight: work.height,
    timings: {
      downscale: tDown - t0,
      upload: tUpload - tDown,
      decompose: tDecomp - tUpload,
      sfs: tSfs - tDecomp,
      readback: tRead - tSfs,
      calibrate: tCal - tRead,
      rugosity: tRug - tCal,
    },
    totalMs: tRug - t0,
    backend: 'webgl2',
  };
}

/** CPU 参考路径（测试与无 GPU 环境兜底） */
export function processOnCPU(input: ProcessInput): ProcessResult {
  const t0 = now();
  const work = input.maxLongEdge ? downscaleImage(input.image, input.maxLongEdge) : input.image;
  const pixelSize = input.physicalWidthM / work.width;
  const decomp = decompose(work);
  const tDecomp = now();
  const height = shapeFromShading(decomp, pixelSize);
  const tSfs = now();
  const target = input.measuredR ?? estimateTargetR(height);
  const cal = calibrateScale(height, target, 8);
  const scaledHeight = applyScale(height, cal.scale);
  const tCal = now();
  const rugosity = rugosityGrid(scaledHeight, 1);
  const tRug = now();
  return {
    decomp,
    height,
    scaledHeight,
    rugosity,
    scale: cal.scale,
    workingWidth: work.width,
    workingHeight: work.height,
    timings: {
      downscale: 0,
      decompose: tDecomp - t0,
      sfs: tSfs - tDecomp,
      calibrate: tCal - tSfs,
      rugosity: tRug - tCal,
    },
    totalMs: tRug - t0,
    backend: 'cpu',
  };
}

/** 无实测值时的兜底目标：取经验 R=1.3（中等结构复杂度礁体） */
function estimateTargetR(hf: HeightField): number {
  void hf;
  return 1.3;
}

export { meanRugosity };
