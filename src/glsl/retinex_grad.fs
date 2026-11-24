#version 300 es
precision highp float;

// 梯度域 Retinex：由对数观测图计算光照梯度（大梯度边缘让给反照）。
// 输出 .r = 光照 x 梯度 lx，.g = 光照 y 梯度 ly。
in vec2 vUv;
uniform sampler2D uLog;
uniform vec2 uTexel;
uniform float uEdgeThresh;
out vec4 outGrad;

void main() {
  vec2 uvR = clamp(vUv + vec2(uTexel.x, 0.0), vec2(0.0), vec2(1.0) - uTexel * 0.5);
  vec2 uvD = clamp(vUv + vec2(0.0, uTexel.y), vec2(0.0), vec2(1.0) - uTexel * 0.5);
  float c = texture(uLog, vUv).r;
  float gx = texture(uLog, uvR).r - c;
  float gy = texture(uLog, uvD).r - c;
  float wx = exp(-pow(abs(gx) / uEdgeThresh, 2.0));
  float wy = exp(-pow(abs(gy) / uEdgeThresh, 2.0));
  outGrad = vec4(gx * wx, gy * wy, 0.0, 1.0);
}
