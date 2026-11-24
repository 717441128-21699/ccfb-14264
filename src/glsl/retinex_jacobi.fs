#version 300 es
precision highp float;

// Retinex Poisson 雅可比迭代一步：Δl = div(lx, ly)。
// 解只相差一个常数，锚定（p99）在 CPU 回读后统一平移，故此处不做锚定。
in vec2 vUv;
uniform sampler2D uL;    // 上一轮光照
uniform sampler2D uGrad; // .r=lx .g=ly
uniform vec2 uTexel;
out vec4 outL;

void main() {
  vec2 uvL = clamp(vUv - vec2(uTexel.x, 0.0), vec2(0.0), vec2(1.0) - uTexel * 0.5);
  vec2 uvR = clamp(vUv + vec2(uTexel.x, 0.0), vec2(0.0), vec2(1.0) - uTexel * 0.5);
  vec2 uvU = clamp(vUv - vec2(0.0, uTexel.y), vec2(0.0), vec2(1.0) - uTexel * 0.5);
  vec2 uvD = clamp(vUv + vec2(0.0, uTexel.y), vec2(0.0), vec2(1.0) - uTexel * 0.5);

  float lx = texture(uGrad, vUv).r;
  float ly = texture(uGrad, vUv).g;
  float lxL = texture(uGrad, uvL).r;
  float lyU = texture(uGrad, uvU).g;
  float rhs = (lx - lxL) + (ly - lyU);

  float lL = texture(uL, uvL).r;
  float lR = texture(uL, uvR).r;
  float lU = texture(uL, uvU).r;
  float lD = texture(uL, uvD).r;
  outL = vec4((lL + lR + lU + lD - rhs) * 0.25, 0.0, 0.0, 1.0);
}
