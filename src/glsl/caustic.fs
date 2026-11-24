#version 300 es
precision highp float;

// 焦散检出 + 圆形结构元素膨胀，输出 .r = 膨胀后焦散掩膜
in vec2 vUv;
uniform sampler2D uImage;
uniform sampler2D uBaseLum;   // log 亮度引导滤波基底
uniform float uCausticThresh; // med + k·MAD
uniform float uSatMax;
uniform vec2 uTexel;
uniform int uFillRadius;
out vec4 outColor;

float satOf(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  return mx > 1e-6 ? (mx - mn) / mx : 0.0;
}

void main() {
  float mask = 0.0;
  int r = uFillRadius;
  for (int dy = -8; dy <= 8; dy++) {
    for (int dx = -8; dx <= 8; dx++) {
      if (dx < -r || dx > r || dy < -r || dy > r) continue;
      if (dx * dx + dy * dy > r * r) continue;
      vec2 ouv = clamp(vUv + vec2(float(dx), float(dy)) * uTexel,
                       vec2(0.0), vec2(1.0) - uTexel * 0.5);
      vec3 I = texture(uImage, ouv).rgb;
      float L = dot(I, vec3(0.2126, 0.7152, 0.0722));
      float residual = log(L + 1e-4) - texture(uBaseLum, ouv).r;
      float S = satOf(I);
      float m = (residual > uCausticThresh && S < uSatMax) ? 1.0 : 0.0;
      mask = max(mask, m);
    }
  }
  outColor = vec4(mask, 0.0, 0.0, 1.0);
}
