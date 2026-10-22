import type { Kind } from './contracts';

export function appIcons(kind: Kind) {
  return (['light', 'dark'] as const).map(theme => ({
    src:
      'data:image/svg+xml,' +
      encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${theme === 'dark' ? '#89a4ff' : '#4057c5'}"/><g fill="none" stroke="${theme === 'dark' ? '#182044' : '#fff'}" stroke-width="2" stroke-linejoin="round">${kind === 'univer' ? '<rect x="7" y="7" width="18" height="18" rx="1"/><path d="M7 13h18M7 19h18M13 7v18"/>' : '<path d="M7 7v18h19M12 21v-6M18 21V9M24 21v-9"/>'}</g></svg>`,
      ),
    mimeType: 'image/svg+xml',
    sizes: ['32x32'],
    theme,
  }));
}
