#version 300 es
precision highp float;

// 双线性上采样（粗级高度场 → 细级），尺度 ×2 校正
in vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uSrcTexel;
uniform float uScale;
out vec4 outColor;

void main() {
  vec2 f = vUv / uSrcTexel - 0.5;
  vec2 f0 = floor(f);
  vec2 t = f - f0;
  vec2 c0 = (f0 + 0.5) * uSrcTexel;
  vec2 c1 = (f0 + 1.5) * uSrcTexel;
  vec2 uv0 = clamp(c0, uSrcTexel * 0.5, vec2(1.0) - uSrcTexel * 0.5);
  vec2 uv1 = clamp(c1, uSrcTexel * 0.5, vec2(1.0) - uSrcTexel * 0.5);
  float a = texture(uSrc, vec2(uv0.x, uv0.y)).r;
  float b = texture(uSrc, vec2(uv1.x, uv0.y)).r;
  float c = texture(uSrc, vec2(uv0.x, uv1.y)).r;
  float d = texture(uSrc, vec2(uv1.x, uv1.y)).r;
  float v = mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
  outColor = vec4(v * uScale, 0.0, 0.0, 1.0);
}
