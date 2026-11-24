#version 300 es
precision highp float;

// Horn SFS 梯度投影步（与 src/core/sfs.ts solveLevel 同公式）。
// 由当前高度场 z 的前向梯度 (pz,qz) 与辐照度 E 投影更新 (p,q)，
// 阴影像素按置信度降权，坡度钳制防尖刺。
in vec2 vUv;
uniform sampler2D uZ;
uniform sampler2D uEconf; // .r=E .g=conf
uniform vec2 uTexel;
uniform vec3 uLight;      // (lx, ly, lz)
uniform float uStep;
uniform float uSlopeClamp;
out vec4 outPQ;           // .r=p .g=q

void main() {
  float z = texture(uZ, vUv).r;
  vec2 uvR = clamp(vUv + vec2(uTexel.x, 0.0), vec2(0.0), vec2(1.0) - uTexel * 0.5);
  vec2 uvD = clamp(vUv + vec2(0.0, uTexel.y), vec2(0.0), vec2(1.0) - uTexel * 0.5);
  float pz = texture(uZ, uvR).r - z;
  float qz = texture(uZ, uvD).r - z;

  vec2 ec = texture(uEconf, vUv).rg;
  float E = ec.x;
  float conf = ec.y;

  float denom = sqrt(1.0 + pz * pz + qz * qz);
  float num = uLight.z - uLight.x * pz - uLight.y * qz;
  float R = num / denom;
  float resid = (E - R) * conf;
  float dRdp = (-uLight.x * denom - num * (pz / denom)) / (denom * denom);
  float dRdq = (-uLight.y * denom - num * (qz / denom)) / (denom * denom);

  float p = clamp(pz + uStep * resid * dRdp, -uSlopeClamp, uSlopeClamp);
  float q = clamp(qz + uStep * resid * dRdq, -uSlopeClamp, uSlopeClamp);
  // 调试通道：.b=E .a=resid（临时）
  outPQ = vec4(p, q, E, resid);
}
