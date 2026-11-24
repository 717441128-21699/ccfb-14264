/**
 * 样带详情页：
 *  - 原图 / 反照层 / 去焦散光照 / 焦散掩膜 / 阴影掩膜分层查看；
 *  - 起伏高度场（晕渲/热力）叠加在照片上，透明度可调；
 *  - 横向剖面、每平方米粗糙度网格、汇总指标与计时；
 *  - 支持上传实测链测 R 重新标定、上传新照片重算。
 */
import { h, toast } from './dom';
import { href } from './router';
import { store } from '../state/store';
import { getBlob } from '../state/db';
import { loadImageFile, floatToImageData, imageToCanvas, maskToImageData } from '../core/imageio';
import { generateTerrain } from '../synth/terrain';
import { renderScene } from '../synth/render';
import {
  heightToImageData, reliefToImageData, rugosityGridToImageData, profileSvg,
} from '../core/viz';
import { runAssessment, toAssessment } from '../core/runner';
import type { ProcessResult } from '../core/processing';
import type { FloatImage } from '../core/types';

type ViewLayer = 'photo' | 'albedo' | 'illum' | 'caustic' | 'shadow' | 'relief' | 'heat' | 'grid';

export function DetailPage(id: string): HTMLElement {
  const wrap = h('div');
  let t = store.get(id);
  if (!t) {
    wrap.append(h('div', { class: 'empty' }, '样带不存在。', h('a', { class: 'link', href: href('/') }, '返回列表')));
    return wrap;
  }

  let result: ProcessResult | null = null;
  let photoImg: FloatImage | null = null;
  let overlayMode: 'relief' | 'heat' | 'grid' = 'relief';
  let overlayAlpha = 0.65;

  const layerHost = h('div', { class: 'card' }, h('h2', {}, '分层与起伏视图'), h('div', { id: 'layer-area' }, h('div', { class: 'muted' }, '加载中…')));
  const overlayHost = h('div', { class: 'card' }, h('h2', {}, '起伏图叠加照片'), h('div', { id: 'overlay-area' }, h('div', { class: 'muted' }, '加载中…')));
  const profileHost = h('div', { class: 'card' }, h('h2', {}, '表面剖面'), h('div', { id: 'profile-area' }));
  const statsHost = h('div', { class: 'card' }, h('h2', {}, '粗糙度指标'), h('div', { id: 'stats-area' }));

  const measuredInput = h('input', { type: 'number', step: '0.001', min: '1', max: '3', placeholder: '如 1.28' }) as HTMLInputElement;
  if (t.assessment?.measuredR) measuredInput.value = String(t.assessment.measuredR);

  async function buildPhoto(): Promise<FloatImage | null> {
    if (t!.synthetic) {
      const s = t!.synthetic!;
      const model = generateTerrain(s.kind as Parameters<typeof generateTerrain>[0], 800, 600, t!.widthM, s.seed);
      const scene = renderScene(model, { causticStrength: s.causticStrength, seed: s.seed });
      return scene.image;
    }
    if (t!.photoKey) {
      const blob = await getBlob(t!.photoKey);
      if (blob) {
        const file = new File([blob], 'photo.jpg', { type: blob.type });
        return loadImageFile(file);
      }
    }
    return null;
  }

  async function recompute(measuredR?: number) {
    const img = await buildPhoto();
    if (!img) {
      toast('找不到照片数据', 'error');
      return;
    }
    photoImg = img;
    const truthR = t!.synthetic?.groundTruthR;
    result = runAssessment({
      image: img,
      physicalWidthM: t!.widthM,
      physicalHeightM: t!.heightM,
      maxLongEdge: 2048,
      measuredR,
      groundTruthR: truthR,
    });
    // 落库
    const assessment = toAssessment(result, {
      image: img, physicalWidthM: t!.widthM, physicalHeightM: t!.heightM,
      measuredR, groundTruthR: truthR,
    });
    t = { ...t!, assessment, updatedAt: new Date().toISOString() };
    await store.save(t);
    renderAll();
    toast(`评估完成：R=${result.rugosity.mean.toFixed(4)}，耗时 ${result.totalMs.toFixed(0)}ms`);
  }

  function layerCanvas(view: ViewLayer): HTMLCanvasElement | null {
    if (!result || !photoImg) return null;
    const r = result;
    switch (view) {
      case 'photo': return imageToCanvas(floatToImageData(photoImg));
      case 'albedo': return imageToCanvas(floatToImageData(r.decomp.albedo, 1));
      case 'illum': return imageToCanvas(floatToImageData(r.decomp.illumination, 1));
      case 'caustic': return imageToCanvas(maskToImageData(r.decomp.causticMask, r.workingWidth, r.workingHeight, [1, 0.75, 0.2]));
      case 'shadow': return imageToCanvas(maskToImageData(r.decomp.shadowMask, r.workingWidth, r.workingHeight, [0.4, 0.55, 0.9]));
      case 'relief': return imageToCanvas(reliefToImageData(r.scaledHeight));
      case 'heat': return imageToCanvas(heightToImageData(r.scaledHeight));
      case 'grid': return imageToCanvas(rugosityGridToImageData(r.rugosity, r.workingWidth, r.workingHeight));
      default: return null;
    }
  }

  function renderLayers() {
    const host = layerHost.querySelector('#layer-area')!;
    if (!result) {
      host.replaceChildren(h('div', { class: 'muted' }, '点击下方"运行评估"生成分层结果。'));
      return;
    }
    const views: { id: ViewLayer; label: string }[] = [
      { id: 'photo', label: '原始照片' },
      { id: 'albedo', label: '反照层' },
      { id: 'illum', label: '去焦散光照' },
      { id: 'caustic', label: '焦散掩膜' },
      { id: 'shadow', label: '阴影掩膜' },
      { id: 'relief', label: '起伏晕渲' },
      { id: 'heat', label: '高度热力' },
      { id: 'grid', label: '每㎡粗糙度' },
    ];
    let active: ViewLayer = 'photo';
    const stage = h('div', { style: { marginTop: '12px' } });
    const show = (v: ViewLayer) => {
      active = v;
      const c = layerCanvas(v);
      stage.replaceChildren();
      if (c) {
        c.className = 'view';
        c.style.maxWidth = '100%';
        stage.append(c);
      }
      buttons.forEach((b) => b.classList.toggle('active', b.dataset.view === v));
    };
    const buttons = views.map((v) => h('button', {
      class: 'secondary small',
      dataset: { view: v.id },
      onclick: () => show(v.id),
    }, v.label));
    host.replaceChildren(h('div', { class: 'layer-toggle' }, ...buttons), stage);
    show(active);
  }

  function renderOverlay() {
    const host = overlayHost.querySelector('#overlay-area')!;
    if (!result || !photoImg) {
      host.replaceChildren(h('div', { class: 'muted' }, '待评估。'));
      return;
    }
    const base = imageToCanvas(floatToImageData(photoImg));
    base.className = 'view base';
    base.style.width = '100%';
    const over = layerCanvas(overlayMode === 'grid' ? 'grid' : overlayMode === 'heat' ? 'heat' : 'relief')!;
    over.style.opacity = String(overlayAlpha);
    const frame = h('div', { class: 'overlay-wrap', style: { width: '100%' } }, base, over);
    const alpha = h('input', {
      type: 'range', min: '0', max: '1', step: '0.05', value: String(overlayAlpha),
      oninput: (e: Event) => {
        overlayAlpha = Number((e.target as HTMLInputElement).value);
        over.style.opacity = String(overlayAlpha);
      },
    });
    const modeSel = h('select', {
      onchange: (e: Event) => {
        overlayMode = (e.target as HTMLSelectElement).value as typeof overlayMode;
        renderOverlay();
      },
    },
      h('option', { value: 'relief' }, '起伏晕渲'),
      h('option', { value: 'heat' }, '高度热力'),
      h('option', { value: 'grid' }, '每㎡粗糙度网格'),
    );
    modeSel.value = overlayMode;
    host.replaceChildren(
      h('div', { class: 'toolbar' }, h('label', { class: 'field' }, '叠加层', modeSel),
        h('label', { class: 'field' }, `透明度 ${overlayAlpha}`, alpha)),
      frame,
    );
  }

  function renderProfile() {
    const host = profileHost.querySelector('#profile-area')!;
    if (!result) {
      host.replaceChildren(h('div', { class: 'muted' }, '待评估。'));
      return;
    }
    host.innerHTML = profileSvg(result.scaledHeight, 0.5);
  }

  function renderStats() {
    const host = statsHost.querySelector('#stats-area')!;
    const a = t!.assessment;
    if (!a || !result) {
      host.replaceChildren(h('div', { class: 'muted' }, '待评估。'));
      return;
    }
    const reference = t!.synthetic?.groundTruthR ?? a.measuredR;
    const timingRows = Object.entries(a.timings).map(([k, v]) =>
      h('tr', {}, h('td', {}, k), h('td', { class: 'mono' }, `${v.toFixed(1)} ms`)));
    const gridRows = a.cells.slice(0, 12).map((c) =>
      h('tr', {},
        h('td', {}, String(c.col)),
        h('td', {}, String(c.row)),
        h('td', { class: 'mono' }, c.rugosity.toFixed(4)),
        h('td', { class: 'mono' }, c.rugosityX.toFixed(4)),
        h('td', { class: 'mono' }, c.rugosityY.toFixed(4))));

    const summaryGrid = h('div', { class: 'grid-4' },
      stat('平均粗糙度 R', a.meanR.toFixed(4), '链长 / 水平距离'),
      stat('标准差', a.stdR.toFixed(4), `每㎡网格 n=${a.cells.length}`),
      stat('参考 R（真值/实测）', reference ? reference.toFixed(4) : '—',
        a.errorPct !== undefined ? `误差 ${a.errorPct.toFixed(2)}%` : '无参考'),
      stat('尺度标定因子', a.scale.toFixed(2), `后端 ${a.backend}`),
    );

    const gateOk = a.errorPct !== undefined && a.errorPct <= 10;
    const gate = h('p', { class: gateOk ? 'good' : 'warn' },
      a.errorPct !== undefined
        ? `与参考值相对误差 ${a.errorPct.toFixed(2)}%（要求 ≤ 10%）${gateOk ? ' ✓ 达标' : ' ✗ 超标'}`
        : '未提供参考值，无法计算误差。');

    const timingTable = h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, '阶段'), h('th', {}, '耗时'))),
      h('tbody', {}, ...timingRows));

    const gridTable = h('table', {},
      h('thead', {}, h('tr', {},
        h('th', {}, '列'), h('th', {}, '行'),
        h('th', {}, 'R'), h('th', {}, '横向 Rx'), h('th', {}, '纵向 Ry'))),
      h('tbody', {}, ...gridRows));

    host.replaceChildren(
      summaryGrid,
      h('h3', {}, '误差门限'),
      gate,
      h('h3', {}, '处理耗时'),
      timingTable,
      h('p', { class: 'muted small' },
        `端到端 ${a.totalMs.toFixed(0)} ms，工作分辨率 ${a.workingWidth}×${a.workingHeight}`),
      h('h3', {}, '每平方米网格（前 12 格）'),
      gridTable,
    );
  }

  function renderAll() {
    renderLayers();
    renderOverlay();
    renderProfile();
    renderStats();
  }

  wrap.append(
    h('div', { class: 'card' },
      h('div', { class: 'flex' },
        h('div', {},
          h('h2', { style: { margin: '0' } }, t.name),
          h('div', { class: 'muted small mt-12' },
            `${t.site} · ${t.year} · ${t.widthM}m × ${t.heightM}m · ${t.terrain}${t.synthetic ? ' · 合成图' : ' · 实测照片'}`),
        ),
        h('div', { class: 'spacer', style: { flex: '1' } }),
        h('a', { class: 'btn secondary', href: href('/') }, '返回列表'),
      ),
      h('div', { class: 'toolbar mt-12' },
        h('label', { class: 'field' }, '链测法实测 R（可选，用于标定）', measuredInput),
        h('button', {
          onclick: async () => {
            const v = measuredInput.value ? Number(measuredInput.value) : undefined;
            await recompute(v);
          },
        }, '运行 / 重新评估'),
        h('label', { class: 'btn secondary', style: { cursor: 'pointer' } }, '上传新照片重算',
          h('input', {
            type: 'file', accept: 'image/*', hidden: true,
            onchange: async (e: Event) => {
              const file = (e.target as HTMLInputElement).files?.[0];
              if (!file) return;
              const img = await loadImageFile(file);
              photoImg = img;
              t = { ...t!, terrain: 'field', synthetic: undefined, photoKey: t!.photoKey };
              result = runAssessment({
                image: img, physicalWidthM: t!.widthM, physicalHeightM: t!.heightM,
                maxLongEdge: 2048, measuredR: measuredInput.value ? Number(measuredInput.value) : undefined,
              });
              const assess = toAssessment(result, {
                image: img, physicalWidthM: t!.widthM, physicalHeightM: t!.heightM,
                measuredR: measuredInput.value ? Number(measuredInput.value) : undefined,
              });
              t = { ...t!, assessment: assess, updatedAt: new Date().toISOString() };
              await store.save(t);
              renderAll();
              toast('已用上传照片重新评估');
            },
          })),
        ),
      ),
    statsHost,
    layerHost,
    overlayHost,
    profileHost,
  );

  // 首次进入自动跑一次（合成图或已存照片）
  void recompute(t.assessment?.measuredR);
  return wrap;
}

function stat(k: string, v: string, sub: string): HTMLElement {
  return h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v), h('div', { class: 'sub' }, sub));
}
