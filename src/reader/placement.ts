export interface ViewRect { left: number; top: number; width: number; height: number }
export interface Size { width: number; height: number }
export interface Placed { left: number; top: number; width: number; side: 'right' | 'left' | 'below' }
export interface PlaceContext {
  sheet: ViewRect | null
  viewport: Size
  topBar: number
  drawer: number
}

const MARGIN = 12
const GAP = 10
const MIN_MARGIN_WIDTH = 260
const MAX_WIDTH = 320

function clampInto(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), Math.max(min, max))
}

function overlapArea(a: ViewRect, b: ViewRect): number {
  const w = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left)
  const h = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top)
  return w > 0 && h > 0 ? w * h : 0
}

export function placePopup(anchor: ViewRect, lit: readonly ViewRect[], viewport: Size, popup: Size, minTop: number = MARGIN): { left: number; top: number } {
  const litBottom = lit.length ? Math.max(...lit.map((b) => b.top + b.height)) : 0
  const litTop = lit.length ? Math.min(...lit.map((b) => b.top)) : 0
  const litRight = lit.length ? Math.max(...lit.map((b) => b.left + b.width)) : 0
  const candidates: { left: number; top: number }[] = [
    { left: anchor.left, top: anchor.top + anchor.height + GAP },
    { left: anchor.left, top: anchor.top - popup.height - GAP },
    { left: anchor.left + anchor.width + GAP, top: anchor.top },
    { left: anchor.left - popup.width - GAP, top: anchor.top },
    { left: anchor.left + anchor.width / 2 - popup.width / 2, top: anchor.top + anchor.height + GAP },
    { left: anchor.left, top: litBottom + GAP },
    { left: anchor.left, top: litTop - popup.height - GAP },
    { left: litRight + GAP, top: anchor.top },
    { left: viewport.width - popup.width - MARGIN, top: litBottom + GAP },
    { left: viewport.width - popup.width - MARGIN, top: minTop },
  ]
  let best: { left: number; top: number } | null = null
  let bestScore = Infinity
  for (const c of candidates) {
    const left = clampInto(c.left, MARGIN, viewport.width - popup.width - MARGIN)
    const top = clampInto(c.top, minTop, viewport.height - popup.height - MARGIN)
    const rect: ViewRect = { left, top, width: popup.width, height: popup.height }
    const score = lit.reduce((sum, b) => sum + overlapArea(rect, b), 0)
    if (score < bestScore) { bestScore = score; best = { left, top } }
    if (score === 0) break
  }
  return best ?? { left: MARGIN, top: minTop }
}

function placeInMargin(anchor: ViewRect, height: number, avoid: readonly ViewRect[], ctx: PlaceContext): Placed | null {
  if (!ctx.sheet) return null
  const { sheet, viewport, topBar, drawer } = ctx
  const sheetRight = sheet.left + sheet.width
  const right = { side: 'right' as const, room: viewport.width - drawer - MARGIN - sheetRight - GAP }
  const left = { side: 'left' as const, room: sheet.left - GAP - MARGIN }
  for (const margin of drawer > 0 ? [left, right] : [right, left]) {
    if (margin.room < MIN_MARGIN_WIDTH) continue
    const width = Math.min(MAX_WIDTH, margin.room)
    const placed: Placed = {
      side: margin.side,
      width,
      left: margin.side === 'right' ? sheetRight + GAP : sheet.left - GAP - width,
      top: clampInto(anchor.top, topBar + GAP, viewport.height - height - MARGIN),
    }
    const rect: ViewRect = { left: placed.left, top: placed.top, width, height }
    if (avoid.every((b) => overlapArea(rect, b) === 0)) return placed
  }
  return null
}

function placeBelow(anchor: ViewRect, height: number, avoid: readonly ViewRect[], ctx: PlaceContext): Placed {
  const { viewport, topBar, drawer } = ctx
  const beside = viewport.width - drawer
  const usable = beside - MARGIN * 2 >= MIN_MARGIN_WIDTH ? beside : viewport.width
  const width = Math.min(MAX_WIDTH, usable - MARGIN * 2)
  const pos = placePopup(anchor, avoid, { width: usable, height: viewport.height }, { width, height }, topBar + GAP)
  return { ...pos, width, side: 'below' }
}

// The margin outside the page sheet is the only place that covers no text, so it comes first.
export function placeNote(anchor: ViewRect, height: number, ctx: PlaceContext): Placed {
  return placeInMargin(anchor, height, [], ctx) ?? placeBelow(anchor, height, [anchor], ctx)
}

export function placeQuestion(anchor: ViewRect, lit: readonly ViewRect[], height: number, ctx: PlaceContext): Placed {
  return placeInMargin(anchor, height, lit, ctx) ?? placeBelow(anchor, height, lit, ctx)
}
