/**
 * 样带列表页：管理每年的数据，按年份/站点筛选，新建合成图或上传照片入口。
 */
import { h } from './dom';
import { href } from './router';
import { store } from '../state/store';
import type { Transect } from '../state/model';
import { getBlob } from '../state/db';

const TERRAIN_LABEL: Record<string, string> = {
  massive: '块状',
  branching: '枝状',
  mixed: '混合',
  flat: '平坦沙底',
  field: '实测照片',
};

export function ListPage(): HTMLElement {
  const years = [...new Set(store.transects.map((t) => t.year))].sort((a, b) => b - a);
  let yearFilter = 0; // 0 = 全部

  const wrap = h('div');

  const renderRows = () => {
    const rows = store.transects
      .filter((t) => (yearFilter ? t.year === yearFilter : true))
      .sort((a, b) => b.year - a.year || b.updatedAt.localeCompare(a.updatedAt));
    if (rows.length === 0) {
      return h('div', { class: 'empty' },
        h('p', {}, '还没有样带数据。'),
        h('p', {}, h('a', { class: 'link', href: href('/test') }, '先去生成几张合成测试图 →')),
      );
    }
    return h('table', {},
      h('thead', {}, h('tr', {},
        h('th', {}, '样带'), h('th', {}, '站点'), h('th', {}, '年份'),
        h('th', {}, '类型'), h('th', {}, '尺寸 (m)'),
        h('th', {}, '平均粗糙度 R'), h('th', {}, '误差'), h('th', {}, '更新时间'), h('th', {}, ''),
      )),
      h('tbody', {}, ...rows.map((t) => rowEl(t))),
    );
  };

  const rowEl = (t: Transect) => {
    const r = t.assessment?.meanR;
    const err = t.assessment?.errorPct;
    return h('tr', {},
      h('td', {}, h('a', { class: 'link', href: href(`/transect/${t.id}`) }, t.name)),
      h('td', {}, t.site || '—'),
      h('td', {}, String(t.year)),
      h('td', {}, h('span', { class: `badge ${t.terrain}` }, TERRAIN_LABEL[t.terrain] ?? t.terrain)),
      h('td', { class: 'mono' }, `${t.widthM}×${t.heightM}`),
      h('td', { class: 'mono' }, r ? r.toFixed(4) : '未评估'),
      h('td', { class: err === undefined ? 'muted' : err <= 10 ? 'good' : 'danger' },
        err === undefined ? '—' : `${err.toFixed(2)}%`),
      h('td', { class: 'muted small' }, new Date(t.updatedAt).toLocaleDateString('zh-CN')),
      h('td', {}, h('button', {
        class: 'secondary small',
        onclick: async () => {
          if (confirm(`删除样带「${t.name}」？该操作不可撤销。`)) {
            await store.remove(t.id);
          }
        },
      }, '删除')),
    );
  };

  const tableCard = h('div', { class: 'card' }, renderRows());

  const unsub = store.subscribe(() => {
    tableCard.replaceChildren(renderRows());
  });
  wrap.addEventListener('remove', unsub);

  const yearSelect = h('select', {
    onchange: (e: Event) => {
      yearFilter = Number((e.target as HTMLSelectElement).value);
      tableCard.replaceChildren(renderRows());
    },
  }, h('option', { value: '0' }, '全部年份'),
    ...years.map((y) => h('option', { value: String(y) }, String(y))));

  wrap.append(
    h('div', { class: 'card' },
      h('h2', {}, '样带列表'),
      h('p', { class: 'muted' }, `共 ${store.transects.length} 条样带，按年度管理礁体结构复杂度评估数据。`),
      h('div', { class: 'toolbar' },
        h('label', { class: 'field' }, '年份筛选', yearSelect),
        h('div', { class: 'spacer' }),
        h('a', { class: 'btn', href: href('/test') }, '生成合成测试图'),
      ),
    ),
    tableCard,
  );
  return wrap;
}

/** 供详情页加载缩略图 URL */
export async function blobUrl(key?: string): Promise<string | null> {
  if (!key) return null;
  const blob = await getBlob(key);
  return blob ? URL.createObjectURL(blob) : null;
}
