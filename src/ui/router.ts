/**
 * 极简 hash 路由。
 */
export type Route =
  | { name: 'list' }
  | { name: 'detail'; id: string }
  | { name: 'stats' }
  | { name: 'test' };

export function parseHash(): Route {
  const h = location.hash.replace(/^#\/?/, '');
  const parts = h.split('/').filter(Boolean);
  if (parts[0] === 'transect' && parts[1]) return { name: 'detail', id: parts[1] };
  if (parts[0] === 'stats') return { name: 'stats' };
  if (parts[0] === 'test') return { name: 'test' };
  return { name: 'list' };
}

export function go(path: string): void {
  location.hash = path.startsWith('#') ? path : `#${path}`;
}

export function href(path: string): string {
  return `#${path}`;
}
