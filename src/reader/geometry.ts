import type { SentenceBox } from '@/lib/types'

export const GEOMETRY = {
  aboveBaseline: 0.98,
  belowBaseline: 0.24,
  underlineBelowBaseline: 0.16,
  underlineThickness: 0.08,
  minGapEm: 0.1,
  mergeGapEm: 1,
  paintMs: 220,
  sheetMs: 300,
  pageWidth: 700,
  drawerWidth: 360,
  topBarHeight: 68,
  stickingPauseMs: 1500,
  prevSectionWindowSec: 3,
} as const

export interface CssRect { left: number; top: number; width: number; height: number }
export interface PageSize { width: number; height: number }

export function boxToRect(box: SentenceBox, page: PageSize, pitchBelow?: number): CssRect {
  const h = box.h > 0 ? box.h : 12
  let above = GEOMETRY.aboveBaseline * h
  let below = GEOMETRY.belowBaseline * h
  if (pitchBelow !== undefined && pitchBelow > 0) {
    const maxExtent = pitchBelow - GEOMETRY.minGapEm * h
    const extent = above + below
    if (extent > maxExtent && extent > 0) {
      const scale = Math.max(maxExtent, h * 0.6) / extent
      above *= scale
      below *= scale
    }
  }
  const topPdf = box.y + above
  const bottomPdf = box.y - below
  return {
    left: page.width > 0 ? (box.x / page.width) * 100 : 0,
    top: page.height > 0 ? ((page.height - topPdf) / page.height) * 100 : 0,
    width: page.width > 0 ? (box.w / page.width) * 100 : 0,
    height: page.height > 0 ? ((topPdf - bottomPdf) / page.height) * 100 : 0,
  }
}

function lineHeightOf(a: SentenceBox, b: SentenceBox): number {
  return Math.max(a.h, b.h) || 12
}

function sameLine(a: SentenceBox, b: SentenceBox): boolean {
  return Math.abs(a.y - b.y) < lineHeightOf(a, b) * 0.5
}

function nearestPitch(box: SentenceBox, others: readonly SentenceBox[]): number | undefined {
  let nearest = Infinity
  for (const other of others) {
    if (other === box || sameLine(box, other)) continue
    const sharesColumn = box.x < other.x + other.w && other.x < box.x + box.w
    if (sharesColumn) nearest = Math.min(nearest, Math.abs(box.y - other.y))
  }
  return Number.isFinite(nearest) ? nearest : undefined
}

export function rectsForBoxes(boxes: readonly SentenceBox[], page: PageSize, neighbours: readonly SentenceBox[] = []): CssRect[] {
  const all = [...boxes, ...neighbours]
  return boxes.map((box) => boxToRect(box, page, nearestPitch(box, all)))
}

export interface StrokeSource { id: string; boxes: readonly SentenceBox[] }
export interface Stroke { ids: string[]; rect: CssRect }

// Boxes that meet on one line become a single box, so the stroke has no seam
// where one sentence ends and the next begins. A wider gap is a column gutter.
export function strokesForSentences(sources: readonly StrokeSource[], page: PageSize, neighbours: readonly SentenceBox[] = []): Stroke[] {
  const owners = new Map<SentenceBox, string[]>()
  for (const source of sources) {
    for (const box of source.boxes) owners.set(box, [...(owners.get(box) ?? []), source.id])
  }
  const merged: { box: SentenceBox; ids: string[] }[] = []
  for (const line of groupBoxesByLine([...owners.keys()])) {
    let current: { box: SentenceBox; ids: string[] } | null = null
    for (const box of line) {
      const ids = owners.get(box) ?? []
      if (current && box.x - (current.box.x + current.box.w) <= lineHeightOf(current.box, box) * GEOMETRY.mergeGapEm) {
        const prior: SentenceBox = current.box
        const bottom = Math.min(prior.y, box.y)
        const top = Math.max(prior.y + prior.h, box.y + box.h)
        const right = Math.max(prior.x + prior.w, box.x + box.w)
        current.box = { ...prior, y: bottom, w: right - prior.x, h: top - bottom }
        current.ids = [...new Set([...current.ids, ...ids])]
      } else {
        current = { box, ids }
        merged.push(current)
      }
    }
  }
  const rects = rectsForBoxes(merged.map((m) => m.box), page, neighbours)
  return merged.map((m, i) => ({ ids: m.ids, rect: rects[i] }))
}

export function underlineRect(box: SentenceBox, page: PageSize, pitchBelow?: number): CssRect {
  const r = boxToRect(box, page)
  const h = box.h > 0 ? box.h : 12
  let below = GEOMETRY.underlineBelowBaseline * h
  const thickness = GEOMETRY.underlineThickness * h
  if (pitchBelow !== undefined && pitchBelow > 0) {
    const maxBelow = pitchBelow - GEOMETRY.minGapEm * h - thickness
    if (maxBelow > 0) below = Math.min(below, maxBelow)
  }
  const topPdf = box.y - below
  return {
    left: r.left,
    top: page.height > 0 ? ((page.height - topPdf) / page.height) * 100 : r.top,
    width: r.width,
    height: page.height > 0 ? (thickness / page.height) * 100 : 0,
  }
}

export function underlineRectsForBoxes(boxes: readonly SentenceBox[], page: PageSize, neighbours: readonly SentenceBox[] = []): CssRect[] {
  const all = [...boxes, ...neighbours]
  return boxes.map((box) => underlineRect(box, page, nearestPitch(box, all)))
}

export function rectsOverlap(a: CssRect, b: CssRect): boolean {
  return a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top
}

export function groupBoxesByLine(boxes: readonly SentenceBox[]): SentenceBox[][] {
  const sorted = [...boxes].sort((a, b) => b.y - a.y || a.x - b.x)
  const lines: SentenceBox[][] = []
  for (const box of sorted) {
    const line = lines.find((l) => sameLine(l[0], box))
    if (line) line.push(box)
    else lines.push([box])
  }
  for (const line of lines) line.sort((a, b) => a.x - b.x)
  return lines
}
