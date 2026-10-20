const paths: Record<string, string> = {
  shield: '<path d="M12 3 4.5 6v5.5c0 4.2 3 7.4 7.5 9.5 4.5-2.1 7.5-5.3 7.5-9.5V6L12 3Z"/><path d="m8.5 12 2.3 2.3 4.7-5"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/>',
  approve: '<circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16 9"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  verify: '<path d="m12 3 2.2 2.2 3.1-.1.8 3 2.6 1.7-1.2 2.9 1.2 2.9-2.6 1.7-.8 3-3.1-.1L12 22l-2.2-2.2-3.1.1-.8-3-2.6-1.7 1.2-2.9-1.2-2.9 2.6-1.7.8-3 3.1.1L12 3Z"/><path d="m8.5 12 2.3 2.3 4.7-5"/>',
  settings: '<path d="m9 3-.6 2.3-2 .9-2.2-.7-2 3.4 1.7 1.6-.2 2.3L2 14.8l2 3.4 2.2-.7 2 .9.6 2.6h4.1l.6-2.6 2-.9 2.2.7 2-3.4-1.7-1.7-.1-2.3 1.6-1.6-2-3.4-2.2.7-2-.9L13 3H9Z"/><circle cx="11" cy="12" r="3"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  up: '<path d="M12 19V5m-5 5 5-5 5 5"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  wallet: '<rect x="3" y="5" width="18" height="15" rx="2"/><path d="M3 9h18m0 4h-5v4h5"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  activity: '<path d="M2 12h4l3-8 5 16 3-8h5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',
  external: '<path d="M14 3h7v7m0-7L10 14"/><path d="M10 3H3v18h18v-7"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 6a8 8 0 0 1 13.6 5M4.3 13a8 8 0 0 0 13.6 5"/>',
  bolt: '<path d="m13 2-9 12h7l-1 8 10-13h-7l1-7Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6l1.4 1.4m10 10 1.4 1.4m0-12.8L17 7M7 17l-1.4 1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/>',
  logout: '<path d="M9 3H4v18h5M10 12h12m-5-5 5 5-5 5"/>',
};

/** Original Aegis A mark: warm-white tile, graphite A, sage notch (matches docs/images/aegis-logo.svg). */
export const mark = (cls = '') => `<svg class="mark ${cls}" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="15" fill="#eeede8"/><rect x=".5" y=".5" width="63" height="63" rx="14.5" fill="none" stroke="#d6d4cb"/><g transform="translate(4 3.5) scale(.875)"><path d="M32 7 60 57H46L32 31 18 57H4Z" fill="#252b2a"/><path d="m27 42-6 10h22l-6-10Z" fill="#9aaa9f"/></g></svg>`;

export const icon = (name: string, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.info}</svg>`;
