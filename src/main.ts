import './styles.css';
import { h } from './ui/dom';
import { parseHash, href, type Route } from './ui/router';
import { store } from './state/store';
import { ListPage } from './ui/list';
import { DetailPage } from './ui/detail';
import { StatsPage } from './ui/stats';
import { TestPage } from './ui/test';

function nav(route: Route): HTMLElement {
  const active = (name: string) => (route.name === name ? 'active' : '');
  return h('nav', { class: 'tabs' },
    h('a', { class: active('list') + (route.name === 'detail' ? ' active' : ''), href: href('/') }, '样带列表'),
    h('a', { class: active('stats'), href: href('/stats') }, '年际统计'),
    h('a', { class: active('test'), href: href('/test') }, '测试图与验证'),
  );
}

function render(route: Route): void {
  const main = document.querySelector<HTMLElement>('#view')!;
  let page: HTMLElement;
  switch (route.name) {
    case 'detail': page = DetailPage(route.id); break;
    case 'stats': page = StatsPage(); break;
    case 'test': page = TestPage(); break;
    default: page = ListPage();
  }
  main.replaceChildren(page);
  document.querySelector('header.topbar')?.replaceWith(
    h('header', { class: 'topbar' },
      h('div', { class: 'brand' }, '珊瑚礁结构复杂度评估', h('small', {}, '焦散剥离 · 明暗恢复 · 链测粗糙度')),
      nav(route),
    ),
  );
}

async function bootstrap(): Promise<void> {
  const app = document.querySelector<HTMLElement>('#app')!;
  app.append(h('main', { id: 'view' }, h('div', { class: 'muted' }, '加载中…')));
  await store.load();
  const route = parseHash();
  render(route);
  window.addEventListener('hashchange', () => render(parseHash()));
}

bootstrap().catch((e) => {
  const main = document.querySelector<HTMLElement>('#view')!;
  main.replaceChildren(h('div', { class: 'card' },
    h('h2', { class: 'danger' }, '启动失败'),
    h('pre', { class: 'log' }, String(e?.stack ?? e))));
});
