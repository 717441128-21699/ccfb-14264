#version 300 es
precision highp float;

// 雅可比积分步：Δz = div(p,q)，一次 Jacobi 更新并去均值（均值由 CPU 侧整体平移，
// GPU 内部先保留，读取后统一中心化；这里做四邻域更新）。
in vec2 vUv;
uniform sampler2D uZ;
uniform sampler2D uPQ; // .r=p .g=q
uniform vec2 uTexel;
out vec4 outZ;

void main() {
  vec2 uvL = clamp(vUv - vec2(uTexel.x, 0.0), vec2(0.0), vec2(1.0) - uTexel * 0.5);
  vec2 uvR = clamp(vUv + vec2(uTexel.x, 0.0), vec2(0.0), vec2(1.0) - uTexel * 0.5);
  vec2 uvU = clamp(vUv - vec2(0.0, uTexel.y), vec2(0.0), vec2(1.0) - uTexel * 0.5);
  vec2 uvD = clamp(vUv + vec2(0.0, uTexel.y), vec2(0.0), vec2(1.0) - uTexel * 0.5);

  float z = texture(uZ, vUv).r;
  float zL = texture(uZ, uvL).r;
  float zR = texture(uZ, uvR).r;
  float zU = texture(uZ, uvU).r;
  float zD = texture(uZ, uvD).r;

  float p = texture(uPQ, vUv).r;
  float q = texture(uPQ, vUv).g;
  float pL = texture(uPQ, uvL).r;
  float qU = texture(uPQ, uvU).g;
  float rhs = (p - pL) + (q - qU);

  float zn = (zL + zR + zU + zD - rhs) * 0.25;
  outZ = vec4(zn, 0.0, 0.0, 1.0);
}
