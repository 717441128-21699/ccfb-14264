/**
 * 测试图生成页：
 *  - 四种礁体起伏模型（块状/枝状/混合/平坦）+ 程序化焦散 + 投射阴影渲染；
 *  - 一键跑 GPU 与 CPU 管线，对照真值粗糙度验证 ≤10% 误差；
 *  - 24MP（6000×4000）性能门限计时；
 *  - 结果可保存进样带列表。
 */
import { h, toast } from './dom';
import { go, href } from './router';
import { generateTerrain } from '../synth/terrain';
import type { TerrainKind } from '../synth/terrain';
import { renderScene } from '../synth/render';
import { meanRugosity } from '../core/geometry';
import { floatToImageData, imageToCanvas } from '../core/imageio';
import { runAssessment, toAssessment, persistAssessment } from '../core/runner';
import type { ProcessResult } from '../core/processing';
import { gpuAvailable } from '../webgl/context';
import { uid } from '../state/db';
import { store } from '../state/store';

const KINDS: TerrainKind[] = ['massive', 'branching', 'mixed', 'flat'];
const LABEL: Record<TerrainKind, string> = {
  massive: '块状珊瑚', branching: '枝状珊瑚', mixed: '混合礁体', flat: '平坦沙底',
};
const PREVIEW_W = 240;
const PREVIEW_H = 180;
const WIDTH_M = 10;
const HEIGHT_M = 7.5;

interface Preview {
  kind: TerrainKind;
  canvas: HTMLCanvasElement;
  truthR: number;
  image: ReturnType<typeof renderScene>['image'];
}

export function TestPage(): HTMLElement {
  const wrap = h('div');
  const previews: Preview[] = [];

  const yearInput = h('input', { type: 'number', value: String(new Date().getFullYear()), min: '2000', max: '2100' }) as HTMLInputElement;
  const seedInput = h('input', { type: 'number', value: '7', min: '1', max: '9999' }) as HTMLInputElement;
  const causticInput = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: '0.55' }) as HTMLInputElement;
  const resSelect = h('select', {},
    h('option', { value: '1600x1200' }, '1600×1200（200 万）'),
    h('option', { value: '2400x1800' }, '2400×1800（430 万）'),
    h('option', { value: '6000x4000' }, '6000×4000（2400 万，性能门限）'),
  ) as HTMLSelectElement;
  const workEdgeInput = h('input', { type: 'number', value: '2048', min: '512', max: '8000', step: '128' }) as HTMLInputElement;

  const log = h('div', { class: 'log' });
  const appendLog = (msg: string, cls = 'info') => {
    log.append(h('div', { class: cls }, `[${new Date().toLocaleTimeString('zh-CN')}] ${msg}`));
    log.scrollTop = log.scrollHeight;
  };

  const previewCard = h('div', { class: 'card' },
    h('h2', {}, '合成测试图（礁体起伏模型 + 焦散 + 投射阴影）'),
    h('div', { class: 'grid-4', id: 'preview-grid' },
      ...KINDS.map((kind) => {
        const card = h('div', {}, h('div', { class: 'muted mb-12' }, LABEL[kind]), h('div', { class: 'small' }, '渲染中…'));
        return card;
      })),
  );

  function renderPreviews() {
    previews.length = 0;
    const grid = previewCard.querySelector('#preview-grid')!;
    grid.replaceChildren();
    const seed = Number(seedInput.value);
    const caustic = Number(causticInput.value);
    for (const kind of KINDS) {
      const model = generateTerrain(kind, PREVIEW_W, PREVIEW_H, WIDTH_M, seed);
      const scene = renderScene(model, { causticStrength: caustic, seed });
      const truthR = meanRugosity(scene.height, 6);
      const canvas = imageToCanvas(floatToImageData(scene.image));
      canvas.className = 'view';
      canvas.style.width = '100%';
      const card = h('div', {},
        h('div', { class: 'muted mb-12' }, LABEL[kind]),
        canvas,
        h('div', { class: 'small mt-12 mono' }, `真值 R = ${truthR.toFixed(4)}`),
      );
      grid.append(card);
      previews.push({ kind, canvas, truthR, image: scene.image });
    }
  }

  const runBtn = h('button', {}, '跑全管线并验证（GPU）');
  const runCpuBtn = h('button', { class: 'secondary' }, 'CPU 参考路径');
  const saveBtn = h('button', { class: 'secondary', disabled: 'true' }, '保存结果到样带列表');
  let lastResults: { kind: TerrainKind; result: ProcessResult; truthR: number; image: Preview['image'] }[] = [];

  const resultCard = h('div', { class: 'card', hidden: true },
    h('h2', {}, '评估结果与真值误差'),
    h('div', { id: 'result-table' }),
  );

  async function runAll(backend: 'webgl2' | 'cpu') {
    if (backend === 'webgl2' && !gpuAvailable()) {
      toast('WebGL2 不可用，改用 CPU', 'error');
      backend = 'cpu';
    }
    runBtn.disabled = true;
    runCpuBtn.disabled = true;
    lastResults = [];
    log.replaceChildren();
    const seed = Number(seedInput.value);
    const caustic = Number(causticInput.value);
    const [rw, rh] = resSelect.value.split('x').map(Number);
    const maxEdge = Number(workEdgeInput.value);
    appendLog(`开始渲染 ${rw}×${rh}（${(rw * rh / 1e6).toFixed(1)}MP），后端=${backend}，工作分辨率长边=${maxEdge}`);

    for (const kind of KINDS) {
      const t0 = performance.now();
      const model = generateTerrain(kind, rw, rh, WIDTH_M, seed);
      const scene = renderScene(model, { causticStrength: caustic, seed });
      const tRender = performance.now();
      const truthR = meanRugosity(scene.height, 4);
      let result: ProcessResult;
      try {
        result = runAssessment({
          image: scene.image,
          physicalWidthM: WIDTH_M,
          physicalHeightM: HEIGHT_M,
          maxLongEdge: maxEdge,
          groundTruthR: truthR,
          backend,
        });
      } catch (e) {
        appendLog(`${LABEL[kind]} 处理失败：${(e as Error).message}`, 'err');
        continue;
      }
      const errPct = Math.abs(result.rugosity.mean - truthR) / truthR * 100;
      const ok = errPct <= 10;
      appendLog(
        `${LABEL[kind]}：真值R=${truthR.toFixed(4)} 测得R=${result.rugosity.mean.toFixed(4)} 误差=${errPct.toFixed(2)}% ` +
        `渲染=${(tRender - t0).toFixed(0)}ms 处理=${result.totalMs.toFixed(0)}ms ${ok ? '✓ 达标' : '✗ 超 10%'}`,
        ok ? 'ok' : 'err',
      );
      lastResults.push({ kind, result, truthR, image: scene.image });
    }
    renderResultTable();
    runBtn.disabled = false;
    runCpuBtn.disabled = false;
    saveBtn.disabled = false;
  }

  function renderResultTable() {
    resultCard.hidden = false;
    const host = resultCard.querySelector('#result-table')!;
    host.replaceChildren(h('table', {},
      h('thead', {}, h('tr', {},
        h('th', {}, '模型'), h('th', {}, '真值 R'), h('th', {}, '测得 R'),
        h('th', {}, '误差'), h('th', {}, '处理耗时'), h('th', {}, '后端'), h('th', {}, '判定'),
      )),
      h('tbody', {}, ...lastResults.map(({ kind, result, truthR }) => {
        const errPct = Math.abs(result.rugosity.mean - truthR) / truthR * 100;
        const ok = errPct <= 10;
        return h('tr', {},
          h('td', {}, h('span', { class: `badge ${kind}` }, LABEL[kind])),
          h('td', { class: 'mono' }, truthR.toFixed(4)),
          h('td', { class: 'mono' }, result.rugosity.mean.toFixed(4)),
          h('td', { class: ok ? 'good' : 'danger' }, `${errPct.toFixed(2)}%`),
          h('td', { class: 'mono' }, `${result.totalMs.toFixed(0)} ms`),
          h('td', {}, result.backend),
          h('td', { class: ok ? 'good' : 'danger' }, ok ? '✓' : '✗'),
        );
      })),
    ));
  }

  runBtn.addEventListener('click', () => void runAll('webgl2'));
  runCpuBtn.addEventListener('click', () => void runAll('cpu'));

  saveBtn.addEventListener('click', async () => {
    const year = Number(yearInput.value);
    let saved = 0;
    for (const { kind, result, truthR, image } of lastResults) {
      const assessment = toAssessment(result, {
        image, physicalWidthM: WIDTH_M, physicalHeightM: HEIGHT_M, groundTruthR: truthR,
      });
      const canvas = imageToCanvas(floatToImageData(image));
      canvas.toBlob(async (blob) => {
        const photoKey = `${uid()}.png`;
        if (blob) await store.saveBlob(photoKey, blob);
        await persistAssessment({
          name: `${year} ${LABEL[kind]}测试样带`,
          site: '合成测试场',
          year,
          terrain: kind,
          widthM: WIDTH_M,
          heightM: HEIGHT_M,
          photoKey,
          synthetic: {
            kind,
            seed: Number(seedInput.value),
            causticStrength: Number(causticInput.value),
            groundTruthR: truthR,
          },
        }, assessment);
      }, 'image/png');
      saved++;
    }
    toast(`已保存 ${saved} 条样带`);
    setTimeout(() => go('/'), 600);
  });

  wrap.append(
    h('div', { class: 'card' },
      h('h2', {}, '渲染参数'),
      h('div', { class: 'grid-4' },
        h('label', { class: 'field' }, '年份', yearInput),
        h('label', { class: 'field' }, '随机种子', seedInput),
        h('label', { class: 'field' }, `焦散强度 ${causticInput.value}`, causticInput),
        h('label', { class: 'field' }, '渲染分辨率', resSelect),
      ),
      h('div', { class: 'grid-2 mt-12' },
        h('label', { class: 'field' }, 'SFS 工作分辨率长边（像素，24MP 原图自动降采样）', workEdgeInput),
        h('div', { class: 'flex', style: { alignItems: 'flex-end' } },
          h('button', { class: 'secondary', onclick: renderPreviews }, '刷新预览'),
        ),
      ),
      h('p', { class: 'muted small mt-12' },
        '验收门限：粗糙度与真值误差 ≤ 10%；2400 万像素照片端到端处理 ≤ 4 秒（GPU）。'),
    ),
    previewCard,
    h('div', { class: 'card' },
      h('h2', {}, '管线验证'),
      h('div', { class: 'toolbar' }, runBtn, runCpuBtn, saveBtn,
        h('a', { class: 'btn secondary', href: href('/') }, '返回列表')),
      resultCard,
      h('h3', {}, '运行日志'),
      log,
    ),
  );

  causticInput.addEventListener('input', () => {
    (causticInput.previousSibling as HTMLElement);
    const label = causticInput.closest('label.field')!;
    label.firstChild!.textContent = `焦散强度 ${causticInput.value} `;
  });
  seedInput.addEventListener('change', renderPreviews);
  causticInput.addEventListener('change', renderPreviews);

  renderPreviews();
  appendLog(`WebGL2 ${gpuAvailable() ? '可用' : '不可用（将使用 CPU 兜底）'}`, gpuAvailable() ? 'ok' : 'err');
  return wrap;
}
