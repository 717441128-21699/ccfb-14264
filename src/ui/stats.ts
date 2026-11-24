/**
 * 统计页：粗糙度年际变化折线、年度箱线分布、误差与耗时汇总。
 * 纯 SVG 绘制，无第三方图表库。
 */
import { h } from './dom';
import { href } from './router';
import { store } from '../state/store';
import type { Transect, YearStat } from '../state/model';

export function StatsPage(): HTMLElement {
  const wrap = h('div');
  const assessed = store.transects.filter((t) => t.assessment);

  if (assessed.length === 0) {
    wrap.append(h('div', { class: 'empty' },
      h('p', {}, '还没有评估结果。'),
      h('a', { class: 'link', href: href('/test') }, '去生成合成测试图并评估 →')));
    return wrap;
  }

  const yearStats = aggregate(assessed);
  const years = yearStats.map((s) => s.year);

  wrap.append(
    h('div', { class: 'card' },
      h('h2', {}, '年度汇总'),
      summaryTable(yearStats),
    ),
    h('div', { class: 'card' },
      h('h2', {}, '粗糙度年际变化'),
      h('div', { innerHTML: lineChart(yearStats) }),
      h('div', { class: 'legend' },
        h('span', {}, h('i', { style: { background: '#38b6a8' } }), '年均 R'),
        h('span', {}, h('i', { style: { background: '#5aa9e6' } }), '±1 标准差区间')),
    ),
    h('div', { class: 'card' },
      h('h2', {}, '年度分布（箱线）'),
      h('div', { innerHTML: boxChart(assessed, years) }),
    ),
    h('div', { class: 'card' },
      h('h2', {}, '误差与性能'),
      errorTable(assessed),
    ),
  );
  return wrap;
}

function aggregate(ts: Transect[]): YearStat[] {
  const map = new Map<number, number[]>();
  for (const t of ts) {
    if (!t.assessment) continue;
    const arr = map.get(t.year) ?? [];
    arr.push(t.assessment.meanR);
    map.set(t.year, arr);
  }
  return [...map.entries()].map(([year, vals]) => {
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const std = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
    return { year, count: vals.length, meanR: mean, stdR: std, minR: Math.min(...vals), maxR: Math.max(...vals) };
  }).sort((a, b) => a.year - b.year);
}

function summaryTable(stats: YearStat[]): HTMLElement {
  return h('table', {},
    h('thead', {}, h('tr', {},
      h('th', {}, '年份'), h('th', {}, '样带数'), h('th', {}, '平均 R'),
      h('th', {}, '标准差'), h('th', {}, '最小 R'), h('th', {}, '最大 R'))),
    h('tbody', {}, ...stats.map((s) => h('tr', {},
      h('td', {}, String(s.year)),
      h('td', {}, String(s.count)),
      h('td', { class: 'mono' }, s.meanR.toFixed(4)),
      h('td', { class: 'mono' }, s.stdR.toFixed(4)),
      h('td', { class: 'mono' }, s.minR.toFixed(4)),
      h('td', { class: 'mono' }, s.maxR.toFixed(4))))),
  );
}

function lineChart(stats: YearStat[]): string {
  const W = 760;
  const H = 300;
  const padL = 56;
  const padR = 20;
  const padT = 24;
  const padB = 40;
  const allR = stats.flatMap((s) => [s.meanR - s.stdR, s.meanR + s.stdR]);
  const yMin = Math.max(1, Math.min(...allR) - 0.02);
  const yMax = Math.max(...allR) + 0.02;
  const x = (i: number) => padL + (stats.length === 1 ? (W - padL - padR) / 2 : (i / (stats.length - 1)) * (W - padL - padR));
  const y = (v: number) => padT + (1 - (v - yMin) / (yMax - yMin)) * (H - padT - padB);

  const meanPts = stats.map((s, i) => `${x(i).toFixed(1)},${y(s.meanR).toFixed(1)}`);
  const upper = stats.map((s, i) => `${x(i).toFixed(1)},${y(s.meanR + s.stdR).toFixed(1)}`);
  const lower = [...stats.map((s, i) => `${x(i).toFixed(1)},${y(s.meanR - s.stdR).toFixed(1)}`)].reverse();
  const gridY = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const yy = padT + f * (H - padT - padB);
    const val = yMax - f * (yMax - yMin);
    return `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="#2a4358" stroke-width="1"/>
      <text x="${padL - 8}" y="${yy + 4}" fill="#8fa9bd" font-size="11" text-anchor="end">${val.toFixed(3)}</text>`;
  }).join('');
  const xLabels = stats.map((s, i) =>
    `<text x="${x(i)}" y="${H - padB + 20}" fill="#8fa9bd" font-size="12" text-anchor="middle">${s.year}</text>`).join('');
  const dots = stats.map((s, i) =>
    `<circle cx="${x(i)}" cy="${y(s.meanR)}" r="4.5" fill="#38b6a8"/>
     <text x="${x(i)}" y="${y(s.meanR) - 10}" fill="#e4edf4" font-size="11" text-anchor="middle">${s.meanR.toFixed(3)}</text>`).join('');

  return `<svg class="svg-chart" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${W}" height="${H}" fill="#071018" rx="8"/>
    ${gridY}
    <polygon points="${[...upper, ...lower].join(' ')}" fill="#5aa9e6" opacity="0.18"/>
    <polyline points="${meanPts.join(' ')}" fill="none" stroke="#38b6a8" stroke-width="2.4"/>
    ${dots}${xLabels}
    <text x="${padL}" y="16" fill="#8fa9bd" font-size="11">粗糙度指数 R（链长/水平距离，越大结构越复杂）</text>
  </svg>`;
}

function boxChart(ts: Transect[], years: number[]): string {
  const W = 760;
  const H = 280;
  const padL = 56;
  const padR = 20;
  const padT = 20;
  const padB = 40;
  const allVals = ts.map((t) => t.assessment!.meanR);
  const yMin = Math.max(1, Math.min(...allVals) - 0.02);
  const yMax = Math.max(...allVals) + 0.02;
  const y = (v: number) => padT + (1 - (v - yMin) / (yMax - yMin)) * (H - padT - padB);
  const slot = (W - padL - padR) / years.length;
  const bw = Math.min(60, slot * 0.5);

  const boxes = years.map((year, i) => {
    const vals = ts.filter((t) => t.year === year).map((t) => t.assessment!.meanR).sort((a, b) => a - b);
    const q = (p: number) => vals[Math.min(vals.length - 1, Math.floor(p * (vals.length - 1)))];
    const cx = padL + slot * (i + 0.5);
    const q1 = q(0.25);
    const med = q(0.5);
    const q3 = q(0.75);
    return `<line x1="${cx}" y1="${y(vals[0])}" x2="${cx}" y2="${y(vals[vals.length - 1])}" stroke="#8fa9bd" stroke-width="1.5"/>
      <rect x="${cx - bw / 2}" y="${y(q3)}" width="${bw}" height="${Math.max(2, y(q1) - y(q3))}" fill="#1d3041" stroke="#5aa9e6" stroke-width="1.5" rx="3"/>
      <line x1="${cx - bw / 2}" y1="${y(med)}" x2="${cx + bw / 2}" y2="${y(med)}" stroke="#38b6a8" stroke-width="2.4"/>
      <text x="${cx}" y="${H - padB + 20}" fill="#8fa9bd" font-size="12" text-anchor="middle">${year}</text>`;
  }).join('');
  return `<svg class="svg-chart" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${W}" height="${H}" fill="#071018" rx="8"/>${boxes}</svg>`;
}

function errorTable(ts: Transect[]): HTMLElement {
  const withErr = ts.filter((t) => t.assessment?.errorPct !== undefined);
  const rows = withErr.map((t) => {
    const e = t.assessment!.errorPct!;
    return h('tr', {},
      h('td', {}, t.name),
      h('td', {}, String(t.year)),
      h('td', { class: 'mono' }, t.assessment!.meanR.toFixed(4)),
      h('td', { class: e <= 10 ? 'good' : 'danger' }, `${e.toFixed(2)}%`),
      h('td', { class: 'mono' }, `${t.assessment!.totalMs.toFixed(0)} ms`),
      h('td', {}, t.assessment!.backend));
  });
  if (rows.length === 0) return h('p', { class: 'muted' }, '没有带参考值（合成真值或链测实测）的评估。');
  return h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, '样带'), h('th', {}, '年份'),
      h('th', {}, 'R'), h('th', {}, '误差'), h('th', {}, '耗时'), h('th', {}, '后端'))),
    h('tbody', {}, ...rows));
}
