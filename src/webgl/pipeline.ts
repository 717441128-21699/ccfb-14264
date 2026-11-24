/**
 * GPU 全管线（WebGL2）：
 *   原图 → 对数梯度域 Retinex 分层（White-Patch p99 锚定）
 *        → 焦散检出/膨胀/剥离 → 阴影掩膜
 *        → 多尺度 Horn SFS 高度场 → 回读
 *
 * 数学与 src/core 下 CPU 参考实现逐 pass 对应，测试页可做 CPU/GPU 一致性比对。
 * 全管线仅 2 次 CPU 回读（Retinex 统计、阴影统计），其余完全在 GPU 完成。
 */
import { DECOMP, LIGHT, SFS } from '../core/types';
import type { DecompResult, FloatImage, HeightField } from '../core/types';
import {
  bindFBO, bindTexture, createFBO, createProgram, createTexture,
  deleteTextureTracked, drawFullscreen, resetTexUnits, useProgram,
} from './engine';import type { Program } from './engine';

import vsSrc from '../glsl/fullscreen.vs?raw';
import causticFs from '../glsl/caustic.fs?raw';
import decompFs from '../glsl/decomp.fs?raw';
import epyramidFs from '../glsl/epyramid.fs?raw';
import gradFs from '../glsl/sfs_grad.fs?raw';
import integrateFs from '../glsl/sfs_integrate.fs?raw';
import upsampleFs from '../glsl/upsample.fs?raw';
import retinexGradFs from '../glsl/retinex_grad.fs?raw';
import retinexJacobiFs from '../glsl/retinex_jacobi.fs?raw';
import retinexShiftFs from '../glsl/retinex_shift.fs?raw';

const RGBA16F = { internal: 0x881a, format: 0x1908, type: 0x140b }; // RGBA16F, RGBA, HALF_FLOAT
// ANGLE/D3D11 对单通道浮点纹理的可渲染支持不全，统一用 RGBA16F 承载（着色器读 .r）。
const SINGLE = RGBA16F;
const SINGLE32 = RGBA16F;

interface GpuDecomp {
  albedo: WebGLTexture;
  illum: WebGLTexture;
  mask: WebGLTexture;
  width: number;
  height: number;
  ambientLum: number;
  maxE: number;
  shadowLo: number;
  shadowHi: number;
}

export class GPUPipeline {
  private gl: WebGL2RenderingContext;
  private progs: Record<string, Program> = {};
  private vao: WebGLVertexArrayObject;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.progs.caustic = createProgram(gl, vsSrc, causticFs);
    this.progs.decomp = createProgram(gl, vsSrc, decompFs);
    this.progs.epyramid = createProgram(gl, vsSrc, epyramidFs);
    this.progs.grad = createProgram(gl, vsSrc, gradFs);
    this.progs.integrate = createProgram(gl, vsSrc, integrateFs);
    this.progs.upsample = createProgram(gl, vsSrc, upsampleFs);
    this.progs.rgrad = createProgram(gl, vsSrc, retinexGradFs);
    this.progs.rjac = createProgram(gl, vsSrc, retinexJacobiFs);
    this.progs.rshift = createProgram(gl, vsSrc, retinexShiftFs);
    this.ensureHelperPrograms();
  }

  private helper = false;
  private ensureHelperPrograms(): void {
    if (this.helper) return;
    const logFs = `#version 300 es
precision highp float;
in vec2 vUv; uniform sampler2D uImage; uniform int uChannel; out vec4 o;
void main(){
  if (uChannel < 0) {
    vec3 c = texture(uImage, vUv).rgb;
    float L = dot(c, vec3(0.2126,0.7152,0.0722));
    o = vec4(log(L + 1e-4), 0.0, 0.0, 1.0);
  } else {
    o = vec4(log(texture(uImage, vUv)[uChannel] + 1e-4), 0.0,0.0,1.0);
  }
}`;
    this.progs.logch = createProgram(this.gl, vsSrc, logFs);
    this.helper = true;
  }

  private tex(w: number, h: number, kind: 'rgba16f' | 'r16f' | 'r32f' = 'rgba16f'): WebGLTexture {
    // r16f/r32f 单通道统一落到 RGBA16F（见 SINGLE 常量说明）
    const opts = kind === 'rgba16f' ? RGBA16F : kind === 'r32f' ? SINGLE32 : SINGLE;
    return createTexture(this.gl, w, h, opts);
  }

  private fbo(w: number, h: number, texs: WebGLTexture[]) {
    return createFBO(this.gl, w, h, texs);
  }

  private run(name: string, setup: (p: Program) => void, target: ReturnType<typeof createFBO> | null, drawBuffers?: number[]): void {
    const p = this.progs[name];
    useProgram(this.gl, p);
    resetTexUnits(this.gl);
    bindFBO(this.gl, target);
    if (target && drawBuffers) this.gl.drawBuffers(drawBuffers);
    setup(p);
    drawFullscreen(this.gl);
  }

  /** 上传 RGB FloatImage 为 RGBA16F 纹理 */
  uploadImage(img: FloatImage): WebGLTexture {
    const rgba = new Float32Array(img.width * img.height * 4);
    for (let i = 0, p = 0; i < img.data.length; i += 3, p++) {
      rgba[p * 4] = img.data[i];
      rgba[p * 4 + 1] = img.data[i + 1];
      rgba[p * 4 + 2] = img.data[i + 2];
      rgba[p * 4 + 3] = 1;
    }
    return createTexture(this.gl, img.width, img.height, RGBA16F, rgba);
  }

  /** 回读 R 通道（翻转 Y 回图像坐标） */
  readR(tex: WebGLTexture, w: number, h: number): Float32Array {
    const fbo = this.fbo(w, h, [tex]);
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, fbo.fbo);
    const buf = new Float32Array(w * h * 4);
    this.gl.readPixels(0, 0, w, h, this.gl.RGBA, this.gl.FLOAT, buf);
    this.gl.deleteFramebuffer(fbo.fbo);
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        out[(h - 1 - y) * w + x] = buf[(y * w + x) * 4];
    return out;
  }

  readRGBA(tex: WebGLTexture, w: number, h: number): Float32Array {
    const fbo = this.fbo(w, h, [tex]);
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, fbo.fbo);
    const buf = new Float32Array(w * h * 4);
    this.gl.readPixels(0, 0, w, h, this.gl.RGBA, this.gl.FLOAT, buf);
    this.gl.deleteFramebuffer(fbo.fbo);
    const out = new Float32Array(buf.length);
    const row = w * 4;
    for (let y = 0; y < h; y++) out.set(buf.subarray(y * row, (y + 1) * row), (h - 1 - y) * row);
    return out;
  }

  /** 梯度域 Retinex 求锚定后的亮度 log 光照（R16F），并返回 CPU 统计所需数组 */
  private retinexLum(srcTex: WebGLTexture, w: number, h: number): {
    baseL: WebGLTexture;
    logLumCpu: Float32Array;
    baseCpu: Float32Array;
    baseP99: number;
  } {
    const gl = this.gl;
    // log 亮度
    const logLum = this.tex(w, h, 'r16f');
    const fLog = this.fbo(w, h, [logLum]);
    this.run('logch', (p) => {
      bindTexture(gl, p, 'uImage', srcTex);
      gl.uniform1i(p.uniforms.get('uChannel')!, -1);
    }, fLog);

    // 光照梯度
    const grad = this.tex(w, h, 'rgba16f');
    const fGrad = this.fbo(w, h, [grad]);
    this.run('rgrad', (p) => {
      bindTexture(gl, p, 'uLog', logLum);
      gl.uniform2f(p.uniforms.get('uTexel')!, 1 / w, 1 / h);
      gl.uniform1f(p.uniforms.get('uEdgeThresh')!, DECOMP.retinexEdgeThresh);
    }, fGrad);

    // Poisson 雅可比（双缓冲 ping-pong）
    let lA = this.tex(w, h, 'r16f');
    let lB = this.tex(w, h, 'r16f');
    const fA = this.fbo(w, h, [lA]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fA.fbo);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.deleteFramebuffer(fA.fbo);
    for (let it = 0; it < DECOMP.retinexIters; it++) {
      const f = this.fbo(w, h, [lB]);
      this.run('rjac', (p) => {
        bindTexture(gl, p, 'uL', lA);
        bindTexture(gl, p, 'uGrad', grad);
        gl.uniform2f(p.uniforms.get('uTexel')!, 1 / w, 1 / h);
      }, f);
      gl.deleteFramebuffer(f.fbo);
      [lA, lB] = [lB, lA];
    }
    this.del(lB);
    this.del(grad);

    // 回读 logLum 与未锚定解，CPU 求 p99、MAD（第 1 次回读，两个 R 通道）
    const logLumCpu = this.readR(logLum, w, h);
    let baseCpu = this.readR(lA, w, h);
    const sortedLog = Float32Array.from(logLumCpu).sort();
    const p99 = sortedLog[Math.min(w * h - 1, Math.floor(w * h * 0.99))];
    const sortedBase = Float32Array.from(baseCpu).sort();
    const curP99 = sortedBase[Math.min(w * h - 1, Math.floor(w * h * 0.99))];
    const shift = p99 - curP99;
    for (let i = 0; i < baseCpu.length; i++) baseCpu[i] += shift;

    // 锚定 shift
    const baseL = this.tex(w, h, 'r16f');
    const fShift = this.fbo(w, h, [baseL]);
    this.run('rshift', (p) => {
      bindTexture(gl, p, 'uL', lA);
      gl.uniform1f(p.uniforms.get('uShift')!, shift);
    }, fShift);
    gl.deleteFramebuffer(fShift.fbo);
    this.del(lA);
    this.del(logLum);
    return { baseL, logLumCpu, baseCpu, baseP99: curP99 + shift };
  }

  /** 全部分层 pass */
  decompose(srcTex: WebGLTexture, w: number, h: number): GpuDecomp {
    const gl = this.gl;
    const n = w * h;
    const { baseL, logLumCpu, baseCpu, baseP99 } = this.retinexLum(srcTex, w, h);

    // 残差 MAD → 焦散阈值
    const resid = new Float32Array(n);
    for (let i = 0; i < n; i++) resid[i] = logLumCpu[i] - baseCpu[i];
    const sorted = Float32Array.from(resid).sort();
    const med = sorted[Math.floor(n / 2)];
    const dev = new Float32Array(n);
    for (let i = 0; i < n; i++) dev[i] = Math.abs(resid[i] - med);
    const devSorted = Float32Array.from(dev).sort();
    const madV = Math.max(devSorted[Math.floor(n / 2)], 1e-4);
    const causticThresh = med + DECOMP.causticMadK * madV;

    // 焦散检出 + 膨胀
    const mask = this.tex(w, h, 'r16f');
    const fMask = this.fbo(w, h, [mask]);
    this.run('caustic', (p) => {
      bindTexture(gl, p, 'uImage', srcTex);
      bindTexture(gl, p, 'uBaseLum', baseL);
      gl.uniform1f(p.uniforms.get('uCausticThresh')!, causticThresh);
      gl.uniform1f(p.uniforms.get('uSatMax')!, DECOMP.causticSatMax);
      gl.uniform2f(p.uniforms.get('uTexel')!, 1 / w, 1 / h);
      gl.uniform1i(p.uniforms.get('uFillRadius')!, DECOMP.causticFillRadius);
    }, fMask);
    gl.deleteFramebuffer(fMask.fbo);

    // 通道偏移：回读每通道 log 均值代价高，改为 GPU 计算 logC 后用一次盒式均值纹理。
    // 这里用第二次回读拿到三通道 log（合并到阴影统计那次），先在 CPU 求偏移与阴影分位。
    const illumLumCpu = new Float32Array(n);
    for (let i = 0; i < n; i++) illumLumCpu[i] = Math.exp(baseCpu[i]);
    const sortedIll = Float32Array.from(illumLumCpu).sort();
    const medLum = sortedIll[Math.floor(0.5 * (n - 1))];
    // 阴影相对中位数自适应（与 CPU decompose 同口径）
    const pLo = medLum * DECOMP.shadowLoRatio;
    const shadowHi = medLum * DECOMP.shadowHiRatio;
    const maxE = sortedIll[n - 1] * 0.98;

    // 第 2 次回读：原图 RGB（用于 CPU 通道 p99 偏移）
    const srcRgba = this.readRGBA(srcTex, w, h);
    const chanOffset: [number, number, number] = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const logC = new Float32Array(n);
      for (let i = 0; i < n; i++) logC[i] = Math.log(srcRgba[i * 4 + c] + 1e-4);
      const sortedC = Float32Array.from(logC).sort();
      const cP99 = sortedC[Math.min(n - 1, Math.floor(n * 0.99))];
      chanOffset[c] = cP99 - baseP99;
    }

    // 主分层 MRT
    const albedo = this.tex(w, h, 'rgba16f');
    const illum = this.tex(w, h, 'rgba16f');
    const fMain = this.fbo(w, h, [albedo, illum]);
    this.run('decomp', (p) => {
      bindTexture(gl, p, 'uImage', srcTex);
      bindTexture(gl, p, 'uMask', mask);
      bindTexture(gl, p, 'uBaseL', baseL);
      gl.uniform3f(p.uniforms.get('uChanOffset')!, chanOffset[0], chanOffset[1], chanOffset[2]);
      gl.uniform1i(p.uniforms.get('uFillRadius')!, DECOMP.causticFillRadius);
      gl.uniform2f(p.uniforms.get('uTexel')!, 1 / w, 1 / h);
      gl.uniform1f(p.uniforms.get('uShadowLo')!, pLo);
      gl.uniform1f(p.uniforms.get('uShadowHi')!, shadowHi);
    }, fMain, [gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.deleteFramebuffer(fMain.fbo);
    this.del(baseL);

    return {
      albedo, illum, mask, width: w, height: h,
      ambientLum: pLo, maxE, shadowLo: pLo, shadowHi,
    };
  }

  /** SFS：从分层纹理恢复高度场（R32F） */
  runSFS(d: GpuDecomp): { zTex: WebGLTexture; width: number; height: number } {
    const gl = this.gl;
    const w = d.width;
    const h = d.height;

    interface Lvl { w: number; h: number; ec: WebGLTexture }
    const levels: Lvl[] = [];
    let cw = w;
    let ch = h;
    let prev: WebGLTexture | null = null;
    for (let k = 0; k < SFS.levels; k++) {
      const ec = this.tex(cw, ch, 'rgba16f');
      const f = this.fbo(cw, ch, [ec]);
      this.run('epyramid', (p) => {
        if (k === 0) {
          bindTexture(gl, p, 'uIllum', d.illum);
          bindTexture(gl, p, 'uShadow', d.illum);
          gl.uniform1f(p.uniforms.get('uAmbLum')!, d.ambientLum);
          gl.uniform1f(p.uniforms.get('uMaxE')!, d.maxE);
          gl.uniform1f(p.uniforms.get('uShadowWeight')!, SFS.shadowWeight);
          // level0 输入就是全尺寸 illum
          gl.uniform2f(p.uniforms.get('uTexel')!, 1 / w, 1 / h);
        } else {
          bindTexture(gl, p, 'uPrev', prev!);
          // 降采样：texel 必须是【输入】（上一级）纹理的，而非输出尺寸
          gl.uniform2f(p.uniforms.get('uTexel')!, 1 / (cw * 2), 1 / (ch * 2));
        }
        gl.uniform1i(p.uniforms.get('uLevel')!, k);
      }, f);
      gl.deleteFramebuffer(f.fbo);
      if (prev) this.del(prev);
      levels.push({ w: cw, h: ch, ec });
      prev = ec;
      cw = Math.max(1, cw >> 1);
      ch = Math.max(1, ch >> 1);
    }

    let zTex: WebGLTexture | null = null;
    for (let k = levels.length - 1; k >= 0; k--) {
      const lvl = levels[k];
      if (zTex) {
        const up = this.tex(lvl.w, lvl.h, 'r32f');
        const f = this.fbo(lvl.w, lvl.h, [up]);
        this.run('upsample', (p) => {
          bindTexture(gl, p, 'uSrc', zTex!);
          const prevLvl = levels[k + 1];
          gl.uniform2f(p.uniforms.get('uSrcTexel')!, 1 / prevLvl.w, 1 / prevLvl.h);
          gl.uniform1f(p.uniforms.get('uScale')!, 2);
        }, f);
        gl.deleteFramebuffer(f.fbo);
        this.del(zTex);
        zTex = up;
      } else {
        zTex = this.tex(lvl.w, lvl.h, 'r32f');
        const f = this.fbo(lvl.w, lvl.h, [zTex]);
        gl.bindFramebuffer(gl.FRAMEBUFFER, f.fbo);
        gl.viewport(0, 0, lvl.w, lvl.h);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.deleteFramebuffer(f.fbo);
      }

      // 预分配缓冲，迭代内复用，避免反复分配全尺寸纹理造成显存峰值/驱动抖动。
      // 与 CPU solveLevel 同数学：每次梯度投影后做 jacobiPerGrad 次 Jacobi 积分。
      // 用 3 缓冲轮转，保证任一轮的读纹理与写纹理不同（否则触发 FBO 反馈循环 0x8CD7）。
      const pqTex = this.tex(lvl.w, lvl.h, 'rgba16f');
      const buf = [this.tex(lvl.w, lvl.h, 'r32f'), this.tex(lvl.w, lvl.h, 'r32f'), this.tex(lvl.w, lvl.h, 'r32f')];
      const fbG = this.fbo(lvl.w, lvl.h, [pqTex]);
      let src = zTex!;
      for (let it = 0; it < SFS.itersPerLevel; it++) {
        // grad：src z → pq
        this.run('grad', (p) => {
          bindTexture(gl, p, 'uZ', src);
          bindTexture(gl, p, 'uEconf', lvl.ec);
          gl.uniform2f(p.uniforms.get('uTexel')!, 1 / lvl.w, 1 / lvl.h);
          gl.uniform3f(p.uniforms.get('uLight')!, LIGHT.x, LIGHT.y, LIGHT.z);
          gl.uniform1f(p.uniforms.get('uStep')!, SFS.step);
          gl.uniform1f(p.uniforms.get('uSlopeClamp')!, SFS.slopeClamp);
        }, fbG);
        // Jacobi：cur 读、nxt 写，在 3 个 buf 中选一个不等于 cur 的作为输出
        let cur = src;
        for (let j = 0; j < SFS.jacobiPerGrad; j++) {
          const nxt = buf.find((t) => t !== cur) as WebGLTexture;
          const fb = this.fbo(lvl.w, lvl.h, [nxt]);
          this.run('integrate', (p) => {
            bindTexture(gl, p, 'uZ', cur);
            bindTexture(gl, p, 'uPQ', pqTex);
            gl.uniform2f(p.uniforms.get('uTexel')!, 1 / lvl.w, 1 / lvl.h);
          }, fb);
          gl.deleteFramebuffer(fb.fbo);
          cur = nxt;
        }
        src = cur;
      }
      gl.deleteFramebuffer(fbG.fbo);
      this.del(pqTex);
      buf.forEach((t) => { if (t !== src) this.del(t); });
      if (src !== zTex) this.del(zTex);
      zTex = src;
    }
    levels.forEach((l) => this.del(l.ec));
    return { zTex: zTex!, width: w, height: h };
  }


  readHeight(zTex: WebGLTexture, w: number, h: number, pixelSize: number): HeightField {
    const z = this.readR(zTex, w, h);
    let mean = 0;
    for (let i = 0; i < z.length; i++) mean += z[i];
    mean /= z.length;
    for (let i = 0; i < z.length; i++) z[i] = (z[i] - mean) * pixelSize;
    return { width: w, height: h, z, pixelSize };
  }

  readDecomp(d: GpuDecomp): DecompResult {
    const albedoRgba = this.readRGBA(d.albedo, d.width, d.height);
    const illumRgba = this.readRGBA(d.illum, d.width, d.height);
    const mask = this.readR(d.mask, d.width, d.height);
    const n = d.width * d.height;
    const albedo = new Float32Array(n * 3);
    const illumination = new Float32Array(n * 3);
    const shadow = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      albedo[i * 3] = albedoRgba[i * 4];
      albedo[i * 3 + 1] = albedoRgba[i * 4 + 1];
      albedo[i * 3 + 2] = albedoRgba[i * 4 + 2];
      illumination[i * 3] = illumRgba[i * 4];
      illumination[i * 3 + 1] = illumRgba[i * 4 + 1];
      illumination[i * 3 + 2] = illumRgba[i * 4 + 2];
      shadow[i] = illumRgba[i * 4 + 3];
    }
    return {
      width: d.width,
      height: d.height,
      albedo: { width: d.width, height: d.height, data: albedo },
      illumination: { width: d.width, height: d.height, data: illumination },
      causticMask: mask,
      shadowMask: shadow,
      ambient: [d.ambientLum, d.ambientLum, d.ambientLum],
    };
  }

  destroyTexture(t: WebGLTexture): void {
    deleteTextureTracked(this.gl, t);
  }

  private del(t: WebGLTexture | null): void {
    deleteTextureTracked(this.gl, t);
  }
}
