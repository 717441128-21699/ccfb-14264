/**
 * 全局单例 WebGL2 上下文（离屏 canvas，跨页面复用）。
 * 监听 webglcontextlost/restored，丢失后自动重建管线，避免连续处理时驱动抖动导致整页失效。
 */
import { GPUPipeline } from './pipeline';

interface Ctx {
  gl: WebGL2RenderingContext;
  pipeline: GPUPipeline;
  canvas: HTMLCanvasElement;
}

let ctx: Ctx | null = null;

function createContext(): Ctx {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2', {
    antialias: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  });
  if (!gl) throw new Error('当前浏览器不支持 WebGL2');
  const extFloat = gl.getExtension('EXT_color_buffer_float');
  const extHalf = gl.getExtension('EXT_color_buffer_half_float');
  if (!extFloat && !extHalf) {
    throw new Error('缺少 EXT_color_buffer_float / EXT_color_buffer_half_float，浮点渲染目标不可用');
  }
  const pipeline = new GPUPipeline(gl);

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    console.warn('WebGL 上下文丢失，标记重建');
    ctx = null;
  });
  canvas.addEventListener('webglcontextrestored', () => {
    console.info('WebGL 上下文已恢复');
    ctx = null;
  });

  return { gl, pipeline, canvas };
}

export function getGPU(): { gl: WebGL2RenderingContext; pipeline: GPUPipeline } {
  if (ctx) return ctx;
  ctx = createContext();
  return ctx;
}

/** 强制丢弃并重建上下文（基准/异常恢复用） */
export function resetGPU(): void {
  if (ctx) {
    const loseExt = ctx.gl.getExtension('WEBGL_lose_context');
    loseExt?.loseContext();
  }
  ctx = null;
}

export function gpuAvailable(): boolean {
  try {
    getGPU();
    return true;
  } catch {
    return false;
  }
}
