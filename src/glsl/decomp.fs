#version 300 es
precision highp float;

// 光照/反照分层主着色器，与 src/core/decomp.ts 同数学。
// 水下光照近似无空间色度变化，每通道 log 光照 = 亮度光照 lL + 恒定通道偏移。
// MRT 输出：
//   target0 .rgb 反照率 A，.a 焦散掩膜
//   target1 .rgb 去焦散平缓光照 L，.a 阴影掩膜
in vec2 vUv;
uniform sampler2D uImage;
uniform sampler2D uMask;   // 膨胀后焦散掩膜 .r
uniform sampler2D uBaseL; // 锚定后亮度 log 光照 .r
uniform vec3 uChanOffset; // 每通道恒定 log 偏移
uniform int uFillRadius;
uniform vec2 uTexel;
uniform float uShadowLo;   // 阴影暗端（亮度）
uniform float uShadowHi;   // 阴影亮端
layout(location = 0) out vec4 outAlbedo;
layout(location = 1) out vec4 outIllum;

float lumOf(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 baseAt(vec2 uv) {
  float l = texture(uBaseL, uv).r;
  return vec3(l) + uChanOffset;
}

void main() {
  vec3 I = texture(uImage, vUv).rgb;
  float mask = texture(uMask, vUv).r;
  vec3 base = baseAt(vUv);

  vec3 illum = exp(base);
  vec3 albedo = I / max(illum, vec3(1e-4));

  if (mask > 0.5) {
    // 邻域非焦散修复：光照取 log 域均值，反照取邻域均值
    vec3 sumLog = vec3(0.0);
    vec3 sumA = vec3(0.0);
    float n = 0.0;
    int r = uFillRadius * 2;
    for (int dy = -16; dy <= 16; dy++) {
      for (int dx = -16; dx <= 16; dx++) {
        if (dx < -r || dx > r || dy < -r || dy > r) continue;
        if (dx * dx + dy * dy > r * r) continue;
        vec2 ouv = clamp(vUv + vec2(float(dx), float(dy)) * uTexel,
                         vec2(0.0), vec2(1.0) - uTexel * 0.5);
        if (texture(uMask, ouv).r > 0.5) continue;
        vec3 nb = baseAt(ouv);
        sumLog += nb;
        sumA += texture(uImage, ouv).rgb / max(exp(nb), vec3(1e-4));
        n += 1.0;
      }
    }
    if (n > 0.5) {
      illum = exp(sumLog / n);
      albedo = sumA / n;
    }
  }
  albedo = min(albedo, vec3(1.2));

  float illumLum = lumOf(illum);
  float shadow = illumLum >= uShadowHi ? 0.0 :
                 illumLum <= uShadowLo ? 1.0 :
                 (uShadowHi - illumLum) / max(uShadowHi - uShadowLo, 1e-6);

  outAlbedo = vec4(albedo, mask);
  outIllum = vec4(illum, shadow);
}
