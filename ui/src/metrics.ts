import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

/** Measured terminal cell size in CSS pixels. */
export interface CellSize {
  cellW: number;
  cellH: number;
}

// Measure one cell using xterm's own metrics: open a hidden terminal in a large
// known box and invert FitAddon's proposed cols/rows. Using a big probe dilutes
// the constant padding/scrollbar offset to a sub-pixel error.
export function measureCell(font: string, fontSize: number, lineHeight: number): CellSize {
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:absolute;left:-9999px;top:-9999px;width:2000px;height:2000px;visibility:hidden';
  document.body.appendChild(probe);

  const term = new Terminal({ fontFamily: font, fontSize, lineHeight });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(probe);

  let cellW = 8;
  let cellH = 17;
  const dims = fit.proposeDimensions();
  if (dims && dims.cols > 0 && dims.rows > 0) {
    cellW = 2000 / dims.cols;
    cellH = 2000 / dims.rows;
  }

  term.dispose();
  probe.remove();
  return { cellW, cellH };
}
