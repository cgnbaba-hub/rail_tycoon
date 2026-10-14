/** Tiny pixel-art icons rendered as crisp inline SVG ('X' = ink, uses currentColor). */
const ICONS: Record<string, string[]> = {
  inspect: ['..XXX....', '.X...X...', 'X.....X..', 'X.....X..', 'X.....X..', '.X...X...', '..XXXXX..', '......XX.', '.......XX'],
  grid: ['XXXXXXXXX', 'X...X...X', 'X...X...X', 'X...X...X', 'XXXXXXXXX', 'X...X...X', 'X...X...X', 'X...X...X', 'XXXXXXXXX'],
  labels: ['.........', 'XXXXXXX..', 'X......X.', 'X.XX.X..X', 'X......X.', 'XXXXXXX..', '.........', '.........', '.........'],
  rotl: ['...XXXX..', '..X....X.', '.X......X', 'XXX.....X', '.X......X', '........X', '.......X.', '..XXXXX..', '.........'],
  rotr: ['..XXXX...', '.X....X..', 'X......X.', 'X.....XXX', 'X......X.', 'X........', '.X.......', '..XXXXX..', '.........'],
  zoomin: ['..XXX....', '.X...X...', 'X..X..X..', 'X.XXX.X..', 'X..X..X..', '.X...X...', '..XXXXX..', '......XX.', '.......XX'],
  zoomout: ['..XXX....', '.X...X...', 'X.....X..', 'X.XXX.X..', 'X.....X..', '.X...X...', '..XXXXX..', '......XX.', '.......XX'],
  pause: ['.........', '.XX..XX..', '.XX..XX..', '.XX..XX..', '.XX..XX..', '.XX..XX..', '.XX..XX..', '.XX..XX..', '.........'],
  help: ['..XXXX...', '.X....X..', '......X..', '.....X...', '....X....', '....X....', '.........', '....X....', '.........'],
  newmap: ['XXXXXXX..', 'X.....X..', 'X.XX..X..', 'X.XXX.XXX', 'X..X..X.X', 'X.....XXX', 'XXXXXXX..', '.........', '.........'],
  close: ['X.......X', '.X.....X.', '..X...X..', '...X.X...', '....X....', '...X.X...', '..X...X..', '.X.....X.', 'X.......X'],
  pin: ['...XXX...', '..XXXXX..', '..XXXXX..', '...XXX...', '..XXXXX..', '....X....', '....X....', '....X....', '.........'],
  track: ['X.X....X.', 'XXXXXXXXX', 'X.X...X.X', 'X.X...X.X', 'XXXXXXXXX', 'X.X...X.X', 'X.X...X.X', 'XXXXXXXXX', '.X....X.X'],
  station: ['....X....', '...XXX...', '..XXXXX..', '.XXXXXXX.', '..X...X..', '..X.X.X..', '..X.X.X..', 'XXXXXXXXX', 'X.......X'],
  bulldoze: ['.........', '.XXXX....', '.X..X....', '.XXXXXXX.', 'XXXXXXXX.', 'XX.XX.XX.', '.XXXXXXX.', '.......XX', '......XXX'],
  undo: ['..X......', '.XX......', 'XXXXXXX..', '.XX....X.', '..X.....X', '........X', '.......X.', '..XXXXX..', '.........'],
  train: ['.........', 'X..XXXXX.', 'XX.X...X.', 'XXXX...X.', 'XXXXXXXXX', 'XXXXXXXXX', '.X.X.X.X.', '.........', '.........'],
  center: ['....X....', '....X....', '..XXXXX..', '..X...X..', 'XXX.X.XXX', '..X...X..', '..XXXXX..', '....X....', '....X....'],
};

export function icon(name: keyof typeof ICONS | string, cls = 'px-icon'): string {
  const rows = ICONS[name];
  if (!rows) return '';
  const w = rows[0].length;
  const h = rows.length;
  let rects = '';
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] !== 'X') {
        x++;
        continue;
      }
      const s = x;
      while (x < row.length && row[x] === 'X') x++;
      rects += `<rect x="${s}" y="${y}" width="${x - s}" height="1"/>`;
    }
  });
  return `<svg class="${cls}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" shape-rendering="crispEdges" fill="currentColor" aria-hidden="true">${rects}</svg>`;
}
