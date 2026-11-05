import { describe, expect, it } from 'vitest'
import { GEOMETRY, boxToRect, rectsForBoxes, groupBoxesByLine, strokesForSentences, underlineRect } from './geometry'

const page = { width: 612, height: 792 }

describe('highlight geometry', () => {
  it('fits the stroke to the baseline: 0.98h above, 0.24h below', () => {
    const box = { x: 100, y: 400, w: 200, h: 12 }
    const r = boxToRect(box, page)
    const topPdf = 792 - (r.top / 100) * 792
    const bottomPdf = topPdf - (r.height / 100) * 792
    expect(topPdf).toBeCloseTo(400 + GEOMETRY.aboveBaseline * 12, 5)
    expect(bottomPdf).toBeCloseTo(400 - GEOMETRY.belowBaseline * 12, 5)
    expect(r.left).toBeCloseTo((100 / 612) * 100, 5)
    expect(r.width).toBeCloseTo((200 / 612) * 100, 5)
  })

  it('keeps adjacent lines from overlapping or striping', () => {
    const boxes = [
      { x: 100, y: 400, w: 200, h: 12 },
      { x: 100, y: 386, w: 200, h: 12 },
      { x: 100, y: 372, w: 200, h: 12 },
    ]
    const rects = rectsForBoxes(boxes, page)
    for (let i = 0; i + 1 < rects.length; i++) {
      const aBottom = rects[i].top + rects[i].height
      expect(aBottom).toBeLessThanOrEqual(rects[i + 1].top + 0.001)
      expect(rects[i + 1].top - aBottom).toBeGreaterThan(0)
    }
  })

  it('leaves a lone line at full painted height', () => {
    const r = boxToRect({ x: 0, y: 400, w: 100, h: 10 }, page)
    expect((r.height / 100) * 792).toBeCloseTo(1.22 * 10, 5)
  })

  it('groups boxes on one baseline into one line', () => {
    const lines = groupBoxesByLine([
      { x: 300, y: 400, w: 100, h: 12 },
      { x: 100, y: 400, w: 180, h: 12 },
      { x: 100, y: 380, w: 100, h: 12 },
    ])
    expect(lines).toHaveLength(2)
    expect(lines[0].map((b) => b.x)).toEqual([100, 300])
  })

  it('keeps full height for two far-apart boxes on one line', () => {
    const rects = rectsForBoxes([{ x: 50, y: 400, w: 100, h: 12 }, { x: 320, y: 400, w: 100, h: 12 }], page)
    for (const r of rects) expect((r.height / 100) * 792).toBeCloseTo(1.22 * 12, 5)
  })
})

describe('note underline', () => {
  it('sits just below the baseline, by the same amount on every line', () => {
    const first = underlineRect({ x: 100, y: 400, w: 200, h: 12 }, page)
    const second = underlineRect({ x: 100, y: 300, w: 200, h: 12 }, page)
    const firstTopPdf = 792 - (first.top / 100) * 792
    const secondTopPdf = 792 - (second.top / 100) * 792
    expect(firstTopPdf).toBeCloseTo(400 - GEOMETRY.underlineBelowBaseline * 12, 5)
    expect(secondTopPdf).toBeCloseTo(300 - GEOMETRY.underlineBelowBaseline * 12, 5)
    expect(firstTopPdf).toBeLessThan(400)
    expect((first.height / 100) * 792).toBeCloseTo(GEOMETRY.underlineThickness * 12, 5)
    expect(first.left).toBeCloseTo((100 / 612) * 100, 5)
    expect(first.width).toBeCloseTo((200 / 612) * 100, 5)
  })

  it('stays clear of the next line when lines are tight', () => {
    const r = underlineRect({ x: 100, y: 400, w: 200, h: 12 }, page, 3)
    const topPdf = 792 - (r.top / 100) * 792
    const bottomPdf = topPdf - (r.height / 100) * 792
    expect(bottomPdf - 397).toBeCloseTo(GEOMETRY.minGapEm * 12, 5)
    expect(bottomPdf).toBeGreaterThan(397)
  })
})

describe('continuous strokes', () => {
  const pct = (points: number) => (points / 612) * 100

  it('joins two sentences on one line into one stroke with no notch', () => {
    const strokes = strokesForSentences([
      { id: 'a', boxes: [{ x: 100, y: 400, w: 120, h: 12 }] },
      { id: 'b', boxes: [{ x: 223, y: 400, w: 150, h: 12 }] },
    ], page)
    expect(strokes).toHaveLength(1)
    expect(strokes[0].ids).toEqual(['a', 'b'])
    expect(strokes[0].rect.left).toBeCloseTo(pct(100), 5)
    expect(strokes[0].rect.width).toBeCloseTo(pct(273), 5)
  })

  it('paints boxes that overlap on one line once, so nothing darkens', () => {
    const strokes = strokesForSentences([
      { id: 'a', boxes: [{ x: 100, y: 400, w: 120, h: 12 }] },
      { id: 'b', boxes: [{ x: 210, y: 400, w: 40, h: 12 }] },
      { id: 'c', boxes: [{ x: 120, y: 400, w: 20, h: 12 }] },
    ], page)
    expect(strokes).toHaveLength(1)
    expect(strokes[0].rect.width).toBeCloseTo(pct(150), 5)
  })

  it('treats reached marks the same way as lit strokes', () => {
    const reached = [
      { id: 'r1', boxes: [{ x: 100, y: 300, w: 100, h: 10 }] },
      { id: 'r2', boxes: [{ x: 204, y: 300, w: 100, h: 10 }] },
    ]
    const strokes = strokesForSentences(reached, page)
    expect(strokes).toHaveLength(1)
    expect(strokes[0].ids).toEqual(['r1', 'r2'])
  })

  it('keeps separate lines separate, without stripes or overlap', () => {
    const strokes = strokesForSentences([
      { id: 'a', boxes: [{ x: 100, y: 400, w: 200, h: 12 }, { x: 100, y: 386, w: 90, h: 12 }] },
      { id: 'b', boxes: [{ x: 193, y: 386, w: 100, h: 12 }, { x: 100, y: 372, w: 200, h: 12 }] },
    ], page)
    expect(strokes.map((s) => s.ids)).toEqual([['a'], ['a', 'b'], ['b']])
    for (let i = 0; i + 1 < strokes.length; i++) {
      const bottom = strokes[i].rect.top + strokes[i].rect.height
      expect(bottom).toBeLessThanOrEqual(strokes[i + 1].rect.top + 0.001)
    }
  })

  it('does not bridge a column gutter', () => {
    const strokes = strokesForSentences([
      { id: 'left', boxes: [{ x: 50, y: 400, w: 200, h: 10 }] },
      { id: 'right', boxes: [{ x: 280, y: 400, w: 200, h: 10 }] },
    ], page)
    expect(strokes).toHaveLength(2)
  })

  it('does not overlap a neighbouring reached line', () => {
    const lit = [{ id: 'a', boxes: [{ x: 100, y: 400, w: 200, h: 12 }] }]
    const seen = [{ x: 100, y: 386, w: 200, h: 12 }]
    const [litStroke] = strokesForSentences(lit, page, seen)
    const [seenStroke] = strokesForSentences([{ id: 's', boxes: seen }], page, lit[0].boxes)
    expect(litStroke.rect.top + litStroke.rect.height).toBeLessThanOrEqual(seenStroke.rect.top + 0.001)
  })
})
