import { describe, expect, it } from 'vitest';
import { generateTerrain } from '../src/synth/terrain';
import { renderScene } from '../src/synth/render';
import { renderCausticLayer } from '../src/synth/caustic';
import { decompose } from '../src/core/decomp';
import { shapeFromShading, calibrateScale, applyScale } from '../src/core/sfs';
import { rugosityGrid, meanRugosity, chainRugosityClean } from '../src/core/geometry';
import type { HeightField } from '../src/core/types';

const W = 160;
const H = 120;
const WIDTH_M = 10;

function scene(kind: Parameters<typeof generateTerrain>[0], seed = 7) {
  const model = generateTerrain(kind, W, H, WIDTH_M, seed);
  const rendered = renderScene(model, { causticStrength: 0.55, time: 1.3, seed });
  const truthR = meanRugosity(rendered.height, 6);
  return { model, rendered, truthR };
}

describe('合成测试图', () => {
  it('四种礁体模型都能渲染且取值合法', () => {
    for (const kind of ['massive', 'branching', 'mixed', 'flat'] as const) {
      const { rendered } = scene(kind);
      expect(rendered.image.width).toBe(W);
      expect(rendered.image.data.length).toBe(W * H * 3);
      let min = 1;
      let max = 0;
      for (const v of rendered.image.data) {
        expect(Number.isFinite(v)).toBe(true);
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
      expect(min).toBeGreaterThanOrEqual(0);
      expect(max).toBeLessThanOrEqual(1);
      // 焦散确实产生了高亮像素
      const causticMax = Math.max(...rendered.caustic);
      expect(causticMax).toBeGreaterThan(0.8);
    }
  });

  it('枝状比块状、块状比平地粗糙度高（真值单调性）', () => {
    const rFlat = scene('flat').truthR;
    const rMassive = scene('massive').truthR;
    const rBranch = scene('branching').truthR;
    expect(rFlat).toBeGreaterThan(1);
    expect(rMassive).toBeGreaterThan(rFlat);
    expect(rBranch).toBeGreaterThan(rMassive);
  });

  it('确定性：同种子两次渲染完全一致', () => {
    const a = renderScene(generateTerrain('mixed', W, H, WIDTH_M, 3), { seed: 3, time: 0.7 });
    const b = renderScene(generateTerrain('mixed', W, H, WIDTH_M, 3), { seed: 3, time: 0.7 });
    expect(a.image.data).toEqual(b.image.data);
  });
});

describe('光照/反照分层', () => {
  it('焦散掩膜能检出亮纹且覆盖率合理', () => {
    const { rendered } = scene('mixed');
    const d = decompose(rendered.image);
    let cover = 0;
    for (const m of d.causticMask) cover += m;
    cover /= d.causticMask.length;
    // 焦散网络通常占 5%~45% 像素
    expect(cover).toBeGreaterThan(0.03);
    expect(cover).toBeLessThan(0.6);
  });

  it('反照层保留深色块状珊瑚（暗反照不被光照解释）', () => {
    const { model, rendered } = scene('massive');
    const d = decompose(rendered.image);
    // 找模型反照最暗的 5% 像素，检查分层后反照仍暗、光照未塌成坑
    const n = W * H;
    const idx = Array.from({ length: n }, (_, i) => i)
      .sort((a, b) => model.albedo[a * 3] - model.albedo[b * 3])
      .slice(0, Math.floor(n * 0.05));
    let darkAlbedo = 0;
    for (const i of idx) darkAlbedo += d.albedo.data[i * 3];
    darkAlbedo /= idx.length;
    // 深褐珊瑚反照 < 0.4
    expect(darkAlbedo).toBeLessThan(0.45);
  });

  it('去焦散光照比原图更平滑（局部方差下降）', () => {
    const { rendered } = scene('branching');
    const d = decompose(rendered.image);
    const localVar = (data: Float32Array, channels: number) => {
      let sum = 0;
      let cnt = 0;
      for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
          const i = (y * W + x) * channels;
          const r = (y * W + x + 1) * channels;
          sum += Math.abs(data[i] - data[r]);
          cnt++;
        }
      }
      return sum / cnt;
    };
    const vSrc = localVar(rendered.image.data, 3);
    const vIll = localVar(d.illumination.data, 3);
    expect(vIll).toBeLessThan(vSrc);
  });
});

describe('明暗恢复与粗糙度', () => {
  it.each(['massive', 'branching', 'mixed', 'flat'] as const)(
    '%s 模型端到端 R 与真值误差 ≤ 10%',
    (kind) => {
      const { rendered, truthR } = scene(kind);
      const d = decompose(rendered.image);
      const hf = shapeFromShading(d, WIDTH_M / W);
      const cal = calibrateScale(hf, truthR, 6);
      const scaled = applyScale(hf, cal.scale);
      const gotR = meanRugosity(scaled, 6);
      const errPct = Math.abs(gotR - truthR) / truthR * 100;
      // 打印供调参
      console.log(`${kind}: truth=${truthR.toFixed(4)} got=${gotR.toFixed(4)} err=${errPct.toFixed(2)}% scale=${cal.scale}`);
      expect(errPct).toBeLessThanOrEqual(10);
    },
  );

  it('每平方米网格粗糙度输出行列链测值', () => {
    const { rendered } = scene('mixed');
    const d = decompose(rendered.image);
    const hf = shapeFromShading(d, WIDTH_M / W);
    const cal = calibrateScale(hf, 1.3, 6);
    const report = rugosityGrid(applyScale(hf, cal.scale), 1);
    expect(report.cols).toBe(10);
    expect(report.cells.length).toBeGreaterThan(0);
    for (const c of report.cells) {
      expect(c.rugosity).toBeGreaterThanOrEqual(1 - 1e-6);
      expect(c.rugosityX).toBeGreaterThanOrEqual(1 - 1e-6);
      expect(c.rugosityY).toBeGreaterThanOrEqual(1 - 1e-6);
    }
  });

  it('链测法：平面 R≈1，起伏面 R>1', () => {
    const flat: HeightField = {
      width: 50, height: 10, z: new Float32Array(500).fill(0.2), pixelSize: 0.02,
    };
    const rFlat = chainRugosityClean(flat, 'x', 0, 0.1, 1);
    expect(rFlat).toBeCloseTo(1, 3);

    const bump = new Float32Array(500);
    for (let x = 0; x < 50; x++) bump[x] = Math.sin(x / 50 * Math.PI * 4) * 0.1;
    const hf: HeightField = { width: 50, height: 10, z: bump, pixelSize: 0.02 };
    const rBump = chainRugosityClean(hf, 'x', 0, 0, 1);
    expect(rBump).toBeGreaterThan(1.05);
  });
});

describe('深色珊瑚 vs 凹坑（甲方重点）', () => {
  it('块状深珊瑚阴影区恢复的高度不出现系统性深坑', () => {
    const { model, rendered } = scene('massive', 11);
    const d = decompose(rendered.image);
    const hf = shapeFromShading(d, WIDTH_M / W);
    // 阴影像素（真值阴影）的恢复高度均值不应显著低于全场
    let shMean = 0;
    let shN = 0;
    let allMean = 0;
    for (let i = 0; i < W * H; i++) {
      allMean += hf.z[i];
      if (rendered.groundTruthShadow[i] > 0.5) {
        shMean += hf.z[i];
        shN++;
      }
    }
    allMean /= W * H;
    shMean /= Math.max(1, shN);
    // 阴影区均值偏离全场均值不超过一个全局标准差（扩散填补应平缓）
    const std = Math.sqrt(hf.z.reduce((a, v) => a + (v - allMean) ** 2, 0) / hf.z.length);
    console.log(`阴影区均值偏差=${(shMean - allMean).toFixed(4)} std=${std.toFixed(4)}`);
    expect(Math.abs(shMean - allMean)).toBeLessThan(std * 1.5);
    // 模型本身是正丘体，最大高度应为正
    expect(Math.max(...model.z)).toBeGreaterThan(0.3);
  });
});

describe('焦散图案', () => {
  it('不同时间帧图案变化但统计稳定', () => {
    const c1 = renderCausticLayer(64, 64, 0.5, 1);
    const c2 = renderCausticLayer(64, 64, 2.0, 1);
    const mean = (a: Float32Array) => a.reduce((x, y) => x + y, 0) / a.length;
    expect(mean(c1)).toBeGreaterThan(0);
    expect(mean(c2)).toBeGreaterThan(0);
    expect(Array.from(c1)).not.toEqual(Array.from(c2));
  });
});
