/**
 * 浏览器端 GPU 自检与性能基准（由 headless-bench.mjs 通过 CDP 驱动）。
 * 挂到 window 上供页面外调用。
 */
import { generateTerrain } from './synth/terrain';
import { renderScene } from './synth/render';
import { meanRugosity } from './core/geometry';
import { runAssessment } from './core/runner';
import { getGPU, resetGPU } from './webgl/context';
import { getLiveTextureCount } from './webgl/engine';
import type { TerrainKind } from './synth/terrain';

interface BenchRow {
  kind: TerrainKind;
  width: number;
  height: number;
  megapixel: number;
  truthR: number;
  gotR: number;
  errorPct: number;
  totalMs: number;
  backend: string;
  timings: Record<string, number>;
}

declare global {
  interface Window {
    reefBench?: {
      glInfo: () => { vendor: string; renderer: string; extFloat: boolean; extHalf: boolean };
      reset: () => { ok: boolean };
      run: (kind: TerrainKind, width: number, height: number, workEdge: number) => Promise<BenchRow>;
      runUpscaled24MP: (workEdge: number) => Promise<BenchRow>;
      diagGPU: (width: number, height: number) => Promise<{ ok: boolean; error?: string; stage?: string }>;
      diagPipeline: (width: number, height: number) => Promise<{ ok: boolean; error?: string; stage?: string }>;
    };
    __BENCH_DEBUG_SFS__?: boolean;
  }
}

export function installBench(): void {
  window.reefBench = {
    glInfo() {
      const gl = getGPU().gl;
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        vendor: dbg ? String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)) : String(gl.getParameter(gl.VENDOR)),
        renderer: dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER)),
        extFloat: !!gl.getExtension('EXT_color_buffer_float'),
        extHalf: !!gl.getExtension('EXT_color_buffer_half_float'),
      };
    },
    reset() {
      resetGPU();
      getGPU();
      return { ok: true };
    },
    async run(kind, width, height, workEdge) {
      const widthM = 10;
      const model = generateTerrain(kind, width, height, widthM, 7);
      const scene = renderScene(model, { causticStrength: 0.55, seed: 7 });
      const truthR = meanRugosity(scene.height, 4);
      const liveBefore = getLiveTextureCount();
      const t0 = performance.now();
      const result = runAssessment({
        image: scene.image,
        physicalWidthM: widthM,
        physicalHeightM: (height / width) * widthM,
        maxLongEdge: workEdge,
        groundTruthR: truthR,
        backend: 'webgl2',
      });
      const totalMs = performance.now() - t0;
      const liveAfter = getLiveTextureCount();
      return {
        kind,
        width,
        height,
        megapixel: (width * height) / 1e6,
        truthR,
        gotR: result.rugosity.mean,
        errorPct: Math.abs(result.rugosity.mean - truthR) / truthR * 100,
        totalMs,
        backend: result.backend,
        timings: result.timings,
        liveLeak: liveAfter - liveBefore,
      };
    },
    /**
     * 24MP 纯 GPU 吞吐测试：小尺寸快速合成后，最近邻放大到 6000×4000，
     * 只测量「一张 24MP 图像」在 GPU 管线内的上传+分层+SFS 处理耗时，
     * 排除 CPU 合成渲染（非被测对象）的干扰。
     */
    async runUpscaled24MP(workEdge) {
      const widthM = 10;
      const bigW = 6000;
      const bigH = 4000;
      // 小图合成（快）
      const small = generateTerrain('mixed', 800, 533, widthM, 7);
      const smallScene = renderScene(small, { causticStrength: 0.55, seed: 7 });
      const truthR = meanRugosity(smallScene.height, 4);
      // 最近邻放大到 24MP
      const big = new Float32Array(bigW * bigH * 3);
      for (let y = 0; y < bigH; y++) {
        const sy = Math.min(small.height - 1, Math.floor((y / bigH) * small.height));
        for (let x = 0; x < bigW; x++) {
          const sx = Math.min(small.width - 1, Math.floor((x / bigW) * small.width));
          const si = (sy * small.width + sx) * 3;
          const di = (y * bigW + x) * 3;
          big[di] = smallScene.image.data[si];
          big[di + 1] = smallScene.image.data[si + 1];
          big[di + 2] = smallScene.image.data[si + 2];
        }
      }
      const image = { width: bigW, height: bigH, data: big };
      const t0 = performance.now();
      const result = runAssessment({
        image,
        physicalWidthM: widthM,
        physicalHeightM: (bigH / bigW) * widthM,
        maxLongEdge: workEdge,
        groundTruthR: truthR,
        backend: 'webgl2',
      });
      const totalMs = performance.now() - t0;
      return {
        kind: 'mixed', width: bigW, height: bigH,
        megapixel: (bigW * bigH) / 1e6,
        truthR, gotR: result.rugosity.mean,
        errorPct: Math.abs(result.rugosity.mean - truthR) / truthR * 100,
        totalMs, backend: result.backend, timings: result.timings,
      };
    },
    async diagGPU(_width, _height) {
      // 最小化 FBO 探测：逐格式检查可渲染性
      try {
        const gl = getGPU().gl;
        const report: Record<string, string> = {};
        const tryFbo = (name: string, ifmt: number, fmt: number, type: number, filter: number) => {
          const tex = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, 64, 64, 0, fmt, type, null);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          const fbo = gl.createFramebuffer();
          gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
          const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
          report[name] = '0x' + st.toString(16) + (st === gl.FRAMEBUFFER_COMPLETE ? ' OK' : ' FAIL');
          gl.deleteFramebuffer(fbo);
          gl.deleteTexture(tex);
        };
        tryFbo('RGBA16F-NEAREST', 0x881a, gl.RGBA, 0x140b, gl.NEAREST);
        tryFbo('RGBA16F-LINEAR', 0x881a, gl.RGBA, 0x140b, gl.LINEAR);
        // 探测空分配 texImage2D 的各种 type 组合
        const allocProbe: Record<string, number> = {};
        for (const type of [gl.HALF_FLOAT, gl.FLOAT, 0x140b]) {
          const tx = gl.createTexture()!;
          gl.bindTexture(gl.TEXTURE_2D, tx);
          gl.getError();
          gl.texImage2D(gl.TEXTURE_2D, 0, 0x881a, 64, 48, 0, gl.RGBA, type, null);
          allocProbe['type=0x' + type.toString(16)] = gl.getError();
          gl.deleteTexture(tx);
        }
        report['alloc'] = JSON.stringify(allocProbe);
        // 复刻 pipeline：先创建并切换过另一个纹理，再建 FBO
        const t1 = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t1);
        gl.texImage2D(gl.TEXTURE_2D, 0, 0x881a, 64, 64, 0, gl.RGBA, 0x140b, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        const t2 = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t2);
        gl.texImage2D(gl.TEXTURE_2D, 0, 0x881a, 64, 64, 0, gl.RGBA, 0x140b, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        const fbo2 = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo2);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t2, 0);
        const st2 = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        report['two-tex-LINEAR'] = '0x' + st2.toString(16) + (st2 === gl.FRAMEBUFFER_COMPLETE ? ' OK' : ' FAIL');
        gl.deleteFramebuffer(fbo2);
        gl.deleteTexture(t1);
        gl.deleteTexture(t2);
        // 最小降采样反馈测试：src 纹理 → 绘制到 dst FBO
        const src = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, src);
        gl.texImage2D(gl.TEXTURE_2D, 0, 0x881a, 64, 64, 0, gl.RGBA, 0x140b, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        const dst = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, dst);
        gl.texImage2D(gl.TEXTURE_2D, 0, 0x881a, 32, 32, 0, gl.RGBA, 0x140b, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        const fb = gl.createFramebuffer()!;
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dst, 0);
        report['dstFBO'] = '0x' + gl.checkFramebufferStatus(gl.FRAMEBUFFER).toString(16);
        gl.getError();
        // 不画，仅绑定 src 到单元 0 看是否报错
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, src);
        report['bindSrcErr'] = '0x' + gl.getError().toString(16);
        gl.deleteFramebuffer(fb);
        gl.deleteTexture(src);
        gl.deleteTexture(dst);
        return { ok: false, error: 'FBO 探测: ' + JSON.stringify(report), stage: 'probe' };
      } catch (e) {
        return { ok: false, error: String((e as Error).message ?? e), stage: (e as Error).stack?.split('\n')[1] ?? '' };
      }
    },
    async diagPipeline(width, height) {
      try {
        const model = generateTerrain('mixed', width, height, 10, 7);
        const scene = renderScene(model, { causticStrength: 0.55, seed: 7 });
        const gpu = getGPU();
        const srcTex = gpu.pipeline.uploadImage(scene.image);
        try {
          const d = gpu.pipeline.decompose(srcTex, width, height);
          // 手动重建 E（与 epyramid level0 同公式），检查动态范围
          const dec = gpu.pipeline.readDecomp(d);
          const il = dec.illumination.data;
          let imn = Infinity, imx = -Infinity, isum = 0;
          const lumArr = new Float32Array(width * height);
          for (let p = 0; p < width * height; p++) {
            const L = 0.2126 * il[p * 3] + 0.7152 * il[p * 3 + 1] + 0.0722 * il[p * 3 + 2];
            lumArr[p] = L; isum += L;
            if (L < imn) imn = L; if (L > imx) imx = L;
          }
          const amb = d.ambientLum;
          let emn = Infinity, emx = -Infinity;
          for (const L of lumArr) {
            const E = Math.min(1, Math.max(0, (L - amb) / Math.max(1 - amb, 1e-4))) / Math.max(d.maxE, 1e-3);
            if (E < emn) emn = E; if (E > emx) emx = E;
          }
          const info = {
            ambientLum: d.ambientLum, maxE: d.maxE,
            illumRange: [imn, imx], eRange: [emn, emx],
            shadowMaskMean: dec.shadowMask.reduce((a, b) => a + b, 0) / dec.shadowMask.length,
          };
          const s = gpu.pipeline.runSFS(d);
          const hf = gpu.pipeline.readHeight(s.zTex, width, height, 10 / width);
          let mn = Infinity, mx = -Infinity;
          for (const v of hf.z) { if (v < mn) mn = v; if (v > mx) mx = v; }
          return { ok: mn !== mx, error: JSON.stringify({ ...info, zRange: [mn, mx] }), stage: 'trace' };
        } finally {
          gpu.pipeline.destroyTexture(srcTex);
        }
      } catch (e) {
        return { ok: false, error: String((e as Error).message ?? e), stage: (e as Error).stack?.split('\n').slice(0, 3).join(' | ') };
      }
    },
  };
}
