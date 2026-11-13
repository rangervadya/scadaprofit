import type { SVGProps } from 'react';

const paths: Record<string, string> = {
  home: 'M3 10.5 12 3l9 7.5M5.5 9.5V21h13V9.5M10 21v-6h4v6',
  doc: 'M6 3h8l4 4v14H6zM14 3v5h4M9 13h6M9 17h4',
  scheme: 'M3 11l5-4 4 4 5-7 4 4M4 12v8h16V9M9 20v-5h5v5',
  archive: 'M3 4h18v5H3zM5 9v11h14V9M10 13h4',
  team: 'M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 18.5V20M11.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM17 11h4m-2-2v4',
  cad: 'M4 20 17 7l3 3L7 23H4zM14 10l3 3M4 4h7M4 8h4',
  settings: 'M4 6h16M4 12h16M4 18h16M8 4v4M16 10v4M11 16v4',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM16.2 16.2 21 21',
  check: 'm4 12.5 5 5L20 6.5',
  x: 'M6 6l12 12M18 6 6 18',
  plus: 'M12 5v14M5 12h14',
  upload: 'M12 16V4m0 0L7 9m5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3',
  download: 'M12 4v12m0 0 5-5m-5 5-5-5M4 18v1a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1',
  refresh: 'M20 11A8 8 0 0 0 6.3 6.3L4 8.5M4 4v4.5h4.5M4 13a8 8 0 0 0 13.7 4.7L20 15.5M20 20v-4.5h-4.5',
  chevronRight: 'm9 5 7 7-7 7',
  chevronDown: 'm5 9 7 7 7-7',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  layers: 'm12 3 9 5-9 5-9-5 9-5ZM3 13l9 5 9-5M3 17l9 5 9-5',
  image: 'M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5M15 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z',
  clock: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16ZM12 8v4.5l3 2',
  alert: 'M12 4 2.5 20h19L12 4ZM12 10v4.5M12 17.5v.5',
  info: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16ZM12 11v5M12 8v.5',
  logout: 'M15 12H4m0 0 4-4m-4 4 4 4M13 4h5a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-5',
  filter: 'M3 5h18l-7 8v6l-4 2v-8z',
  play: 'm8 5 11 7-11 7z',
  edit: 'M4 20h4L20 8l-4-4L4 16zM14 6l4 4',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
  save: 'M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6',
  zoomIn: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM16.2 16.2 21 21M11 8v6M8 11h6',
  zoomOut: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM16.2 16.2 21 21M8 11h6',
  external: 'M14 4h6v6M20 4 11 13M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  list: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
  users: 'M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 18.5V20M11.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z',
  building: 'M4 21V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v16M15 9h4a1 1 0 0 1 1 1v11M8 8h3M8 12h3M8 16h3M4 21h16',
  route: 'M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM18 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM8 17h6a4 4 0 0 0 0-8H9a3 3 0 0 1 0-6h7',
  menu: 'M4 7h16M4 12h16M4 17h16',
  server: 'M4 5h16v6H4zM4 13h16v6H4zM7 8h.01M7 16h.01',
  camera: 'M4 8h3l2-3h6l2 3h3v11H4zM12 16a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z',
  sparkles: 'M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM18 16l.9 2.3 2.3.9-2.3.9L18 22l-.9-2.3-2.3-.9 2.3-.9z',
};

export type IconName = keyof typeof paths | string;

export function Icon({ name, size = 18, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  const d = paths[name] || paths.info;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      <path d={d} />
    </svg>
  );
}

export function BrandMark({ size = 30 }: { size?: number }) {
  return (
    <svg viewBox="0 0 32 36" width={size} height={size * 1.12} aria-hidden="true">
      <path fill="#e0e0e0" d="M19 1c1 8-7 10-7 17 0 2 1 3 2 4-5-1-8-4-7-8C9 9 15 6 19 1Z" />
      <path fill="#b0b0b0" d="M21 12c7 5 9 10 6 16-2 4-6 6-11 7 4-3 5-6 3-9-1-2-4-3-4-6 0-3 3-6 6-8Z" />
      <path fill="#d0d0d0" d="M6 19c0 5 6 7 7 11l-2 4C5 31 2 26 6 19Z" />
    </svg>
  );
}