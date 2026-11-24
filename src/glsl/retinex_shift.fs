#version 300 es
precision highp float;

// Retinex 解的常数锚定：l += uShift（CPU 由 p99 统计给出）。
in vec2 vUv;
uniform sampler2D uL;
uniform float uShift;
out vec4 outL;

void main() {
  outL = vec4(texture(uL, vUv).r + uShift, 0.0, 0.0, 1.0);
}
