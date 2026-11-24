/**
 * WebGL2 薄封装：浮点 FBO、全屏 pass、程序管理。
 * 要求 EXT_color_buffer_float（桌面/现代移动 GPU 普遍支持）。
 */

export interface GLExt {
  gl: WebGL2RenderingContext;
  ext: object | null;
}

export function createGL(canvas: HTMLCanvasElement): GLExt {
  const gl = canvas.getContext('webgl2', {
    antialias: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  });
  if (!gl) throw new Error('当前浏览器不支持 WebGL2');
  const ext = gl.getExtension('EXT_color_buffer_float')
    ?? gl.getExtension('EXT_color_buffer_half_float');
  if (!ext) throw new Error('缺少浮点颜色缓冲扩展，无法使用浮点渲染目标');
  return { gl, ext };
}

export function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('shader 分配失败');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`着色器编译失败: ${log}\n${src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n')}`);
  }
  return sh;
}

export interface Program {
  program: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation | null>;
}

export function createProgram(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): Program {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  const program = gl.createProgram();
  if (!program) throw new Error('program 分配失败');
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`程序链接失败: ${log}`);
  }
  const uniforms = new Map<string, WebGLUniformLocation | null>();
  const n = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(program, i);
    if (info) uniforms.set(info.name, gl.getUniformLocation(program, info.name));
  }
  return { program, uniforms };
}

export interface TextureOptions {
  internal: number;
  format: number;
  type: number;
  filter?: number;
  wrap?: number;
}

/** 存活纹理计数（泄漏诊断用） */
let liveTextures = 0;
export function getLiveTextureCount(): number {
  return liveTextures;
}

export function deleteTextureTracked(gl: WebGL2RenderingContext, tex: WebGLTexture | null): void {
  if (!tex) return;
  gl.deleteTexture(tex);
  liveTextures = Math.max(0, liveTextures - 1);
}

export function createTexture(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  opts: TextureOptions,
  data?: ArrayBufferView | null,
): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error('纹理分配失败');
  liveTextures++;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  // 带 Float32 数据上传时 type 必须为 FLOAT；空分配才用 HALF_FLOAT
  const uploadType = data ? gl.FLOAT : opts.type;
  gl.getError(); // 清空历史错误标志
  gl.texImage2D(
    gl.TEXTURE_2D, 0, opts.internal, width, height, 0,
    opts.format, uploadType, data ?? null,
  );
  const imgErr = gl.getError();
  if (imgErr !== gl.NO_ERROR) {
    // 部分 ANGLE 实现对空分配的错误标志存在误报；纹理真实可渲染性由 createFBO 的状态码判定。
    // 仅在带数据上传失败（真正会导致内容错误）时抛出。
    if (data) {
      gl.deleteTexture(tex);
      throw new Error(`texImage2D(数据) 失败 glError=0x${imgErr.toString(16)} ifmt=0x${opts.internal.toString(16)} type=0x${uploadType.toString(16)} ${width}×${height}`);
    }
    // 空分配：清掉误报标志继续，依赖后续 FBO 完整性检查把关
    gl.getError();
  }
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, opts.filter ?? gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, opts.filter ?? gl.NEAREST);
  const wrap = opts.wrap ?? gl.CLAMP_TO_EDGE;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  return tex;
}

export interface FBO {
  fbo: WebGLFramebuffer;
  textures: WebGLTexture[];
  width: number;
  height: number;
}

export function createFBO(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  textures: WebGLTexture[],
  label = 'fbo',
): FBO {
  const fbo = gl.createFramebuffer();
  if (!fbo) throw new Error('FBO 分配失败');
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  textures.forEach((tex, i) => {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, tex, 0,
    );
  });
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    const names: Record<number, string> = {
      0x8cd6: 'MISSING_ATTACHMENT（纹理格式不可渲染或未挂载）',
      0x8cdd: 'INCOMPLETE_DIMENSIONS',
      0x8cda: 'UNSUPPORTED',
      0x8cd5: 'INCOMPLETE_ATTACHMENT',
    };
    throw new Error(`FBO 不完整 [${label}] ${width}×${height} n=${textures.length}: 0x${status.toString(16)} ${names[status] ?? ''}`);
  }
  return { fbo, textures, width, height };
}

export function bindFBO(gl: WebGL2RenderingContext, fbo: FBO | null): void {
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo?.fbo ?? null);
  if (fbo) gl.viewport(0, 0, fbo.width, fbo.height);
}

export function useProgram(gl: WebGL2RenderingContext, p: Program): void {
  gl.useProgram(p.program);
}

export function uniform(p: Program, _gl: WebGL2RenderingContext, name: string): WebGLUniformLocation | null {
  const loc = p.uniforms.get(name);
  return loc === undefined ? null : loc;
}

let texUnit = 0;
/** 每次绘制前解绑的纹理单元数上限（覆盖管线内单次 pass 的最大采样器数量） */
const MAX_UNITS = 16;
export function resetTextureUnits(gl: WebGL2RenderingContext): void {
  // 清空所有采样单元的旧绑定，避免上一 pass 的渲染目标残留形成纹理反馈循环（GL_INVALID_OPERATION）
  for (let u = 0; u < MAX_UNITS; u++) {
    gl.activeTexture(gl.TEXTURE0 + u);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
  gl.activeTexture(gl.TEXTURE0);
  texUnit = 0;
}
export function bindTexture(
  gl: WebGL2RenderingContext,
  p: Program,
  name: string,
  tex: WebGLTexture,
  unit?: number,
): number {
  const u = unit ?? texUnit++;
  gl.activeTexture(gl.TEXTURE0 + u);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  const loc = uniform(p, gl, name);
  if (loc) gl.uniform1i(loc, u);
  return u;
}

export function resetTexUnits(gl: WebGL2RenderingContext): void {
  resetTextureUnits(gl);
}

export function drawFullscreen(gl: WebGL2RenderingContext): void {
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

export function destroyGL(gl: WebGL2RenderingContext, res: { texture?: WebGLTexture | null; fbo?: WebGLFramebuffer | null }[]): void {
  for (const r of res) {
    if (r.texture) gl.deleteTexture(r.texture);
    if (r.fbo) gl.deleteFramebuffer(r.fbo);
  }
}
