import { describe, expect, it } from 'vitest'
import { placeNote, placePopup, placeQuestion, type PlaceContext, type ViewRect } from './placement'

const viewport = { width: 1000, height: 800 }
const popup = { width: 320, height: 180 }

describe('popup placement', () => {
  it('stays on screen at the edges', () => {
    const p = placePopup({ left: 960, top: 760, width: 30, height: 20 }, [], viewport, popup)
    expect(p.left + popup.width).toBeLessThanOrEqual(1000 - 12)
    expect(p.top + popup.height).toBeLessThanOrEqual(800 - 12)
    expect(p.left).toBeGreaterThanOrEqual(12)
    expect(p.top).toBeGreaterThanOrEqual(12)
  })
  it('avoids lit boxes when a clean spot exists', () => {
    const lit = [{ left: 100, top: 130, width: 300, height: 200 }]
    const p = placePopup({ left: 100, top: 100, width: 200, height: 20 }, lit, viewport, popup)
    const overlaps = p.left < 400 && p.left + 320 > 100 && p.top < 330 && p.top + 180 > 130
    expect(overlaps).toBe(false)
  })
  it('prefers below the anchor when clear', () => {
    const p = placePopup({ left: 100, top: 100, width: 200, height: 20 }, [], viewport, popup)
    expect(p.top).toBe(130)
  })
  it('never rises above the given top limit', () => {
    const p = placePopup({ left: 100, top: 20, width: 200, height: 20 }, [{ left: 0, top: 0, width: 1000, height: 300 }], viewport, popup, 78)
    expect(p.top).toBeGreaterThanOrEqual(78)
  })
})

function overlaps(a: ViewRect, b: ViewRect): boolean {
  return a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top
}

function context(width: number, drawer = 0, height = 800): PlaceContext {
  const content = width - drawer
  const sheetWidth = Math.min(700, content - 40)
  return { sheet: { left: (content - sheetWidth) / 2, top: 86, width: sheetWidth, height: 900 }, viewport: { width, height }, topBar: 68, drawer }
}

const line = (ctx: PlaceContext, top = 300): ViewRect => ({ left: (ctx.sheet?.left ?? 0) + 80, top, width: 300, height: 18 })

describe('page note placement', () => {
  it('sits in the right margin, aligned with its line', () => {
    const ctx = context(1440)
    const p = placeNote(line(ctx), 120, ctx)
    expect(p.side).toBe('right')
    expect(p.left).toBeGreaterThanOrEqual(1070)
    expect(p.left + p.width).toBeLessThanOrEqual(1440)
    expect(p.top).toBe(300)
    expect(p.width).toBe(320)
  })
  it('uses the left margin when the drawer is open', () => {
    const ctx = context(1800, 360)
    const p = placeNote(line(ctx), 120, ctx)
    expect(p.side).toBe('left')
    expect(p.left).toBeGreaterThanOrEqual(0)
    expect(p.left + p.width).toBeLessThanOrEqual(ctx.sheet!.left)
  })
  it('uses the left margin when the right has too little room', () => {
    const ctx: PlaceContext = { sheet: { left: 400, top: 86, width: 700, height: 900 }, viewport: { width: 1200, height: 800 }, topBar: 68, drawer: 0 }
    expect(placeNote(line(ctx), 120, ctx).side).toBe('left')
  })
  it('stays in a margin at a 1280 laptop width', () => {
    const ctx = context(1280)
    const p = placeNote(line(ctx), 120, ctx)
    expect(p.side).toBe('right')
    expect(p.left).toBeGreaterThanOrEqual(ctx.sheet!.left + ctx.sheet!.width)
    expect(p.left + p.width).toBeLessThanOrEqual(1280)
  })
  it('clamps below the top bar and above the viewport bottom', () => {
    const ctx = context(1440)
    expect(placeNote(line(ctx, 10), 120, ctx).top).toBeGreaterThanOrEqual(68)
    const low = placeNote(line(ctx, 790), 120, ctx)
    expect(low.top + 120).toBeLessThanOrEqual(800)
  })
  it('falls back below the line on a narrow screen, on screen and clear of its line', () => {
    const ctx = context(420)
    const anchor = line(ctx)
    const p = placeNote(anchor, 120, ctx)
    expect(p.side).toBe('below')
    expect(p.top).toBeGreaterThanOrEqual(anchor.top + anchor.height)
    expect(p.left).toBeGreaterThanOrEqual(0)
    expect(p.left + p.width).toBeLessThanOrEqual(420)
  })
  it('opens above the line when below would run off the bottom on a narrow screen', () => {
    const ctx = context(420)
    const anchor = line(ctx, 740)
    const p = placeNote(anchor, 120, ctx)
    expect(overlaps({ left: p.left, top: p.top, width: p.width, height: 120 }, anchor)).toBe(false)
    expect(p.top).toBeGreaterThanOrEqual(68)
  })
  it('falls back when both margins are too small because the drawer narrows the page', () => {
    const ctx = context(1280, 360)
    const p = placeNote(line(ctx), 120, ctx)
    expect(p.side).toBe('below')
    expect(p.left + p.width).toBeLessThanOrEqual(1280 - 360)
  })
  it('stays on a phone with the drawer over the whole screen', () => {
    const ctx: PlaceContext = { sheet: { left: 20, top: 86, width: 335, height: 500 }, viewport: { width: 375, height: 700 }, topBar: 68, drawer: 345 }
    const p = placeNote({ left: 40, top: 200, width: 200, height: 18 }, 120, ctx)
    expect(p.width).toBeGreaterThan(200)
    expect(p.left + p.width).toBeLessThanOrEqual(375)
  })
})

describe('question placement', () => {
  const height = 280
  const litOn = (ctx: PlaceContext): ViewRect[] => [line(ctx, 100), line(ctx, 118), line(ctx, 136)]

  it('sits in a margin at laptop widths', () => {
    for (const width of [1280, 1366, 1440]) {
      const ctx = context(width)
      const lit = litOn(ctx)
      const p = placeQuestion(lit[0], lit, height, ctx)
      expect(p.side).toBe('right')
      expect(p.left).toBeGreaterThanOrEqual(ctx.sheet!.left + ctx.sheet!.width)
    }
  })
  it('never overlaps the top bar, even with lit text at the very top', () => {
    const ctx = context(1440)
    const lit = [{ left: 500, top: 20, width: 300, height: 18 }]
    expect(placeQuestion(lit[0], lit, height, ctx).top).toBeGreaterThanOrEqual(68)
    const narrow = context(420)
    expect(placeQuestion({ left: 40, top: 20, width: 300, height: 18 }, [{ left: 40, top: 20, width: 300, height: 18 }], height, narrow).top).toBeGreaterThanOrEqual(68)
  })
  it('covers no lit text on a narrow screen when a clear spot exists', () => {
    const ctx = context(420)
    const lit = litOn(ctx).map((r) => ({ ...r, left: 40, width: 340 }))
    const p = placeQuestion(lit[0], lit, height, ctx)
    const rect = { left: p.left, top: p.top, width: p.width, height }
    for (const b of lit) expect(overlaps(rect, b)).toBe(false)
  })
  it('leaves the margin when lit text reaches into it', () => {
    const ctx = context(1440)
    const lit = [...litOn(ctx), { left: 1100, top: 300, width: 300, height: 18 }, { left: 40, top: 300, width: 300, height: 18 }]
    const p = placeQuestion(lit[0], lit, height, ctx)
    const rect = { left: p.left, top: p.top, width: p.width, height }
    for (const b of lit) expect(overlaps(rect, b)).toBe(false)
  })
})
