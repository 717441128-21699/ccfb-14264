#version 300 es
precision highp float;

// 构建辐照度 E 与置信度金字塔。
// level 0：由光照图扣环境项并归一化；更高级：2x2 面积均值降采样。
in vec2 vUv;
uniform sampler2D uIllum;   // 光照 RGB（仅 level 0 用）
uniform sampler2D uPrev;    // 上一级 .r=E .g=conf（level>0 用）
uniform sampler2D uShadow;  // 阴影掩膜 .a（仅 level 0 用）
uniform vec2 uTexel;        // level>0 时 = 输入（上一级）纹理 texel
uniform float uAmbLum;
uniform float uMaxE;
uniform float uShadowWeight;
uniform int uLevel;
out vec4 outColor; // .r = E, .g = conf

float lumOf(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

void main() {
  if (uLevel == 0) {
    float L = lumOf(texture(uIllum, vUv).rgb);
    float E = clamp((L - uAmbLum) / max(1.0 - uAmbLum, 1e-4), 0.0, 1.0) / max(uMaxE, 1e-3);
    float sh = texture(uShadow, vUv).a;
    float conf = 1.0 - (1.0 - uShadowWeight) * sh;
    outColor = vec4(E, conf, 0.0, 1.0);
  } else {
    // 输出像素中心 vUv 对应输入纹理的 2x2 邻域中心，向四个半 texel 方向采样
    vec2 t = uTexel;
    vec4 s =
      texture(uPrev, vUv + vec2(-t.x, -t.y)) +
      texture(uPrev, vUv + vec2( t.x, -t.y)) +
      texture(uPrev, vUv + vec2(-t.x,  t.y)) +
      texture(uPrev, vUv + vec2( t.x,  t.y));
    outColor = vec4(s.r * 0.25, s.g * 0.25, 0.0, 1.0);
  }
}
