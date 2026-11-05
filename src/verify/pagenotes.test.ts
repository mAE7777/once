import { describe, expect, it } from 'vitest'
import { verifyPageNotes } from './verify'
import type { Plan, Sentence } from '@/lib/types'

const sentences: Sentence[] = [{ id: 's1', page: 1, start: 0, end: 20, text: 'Attention is all you need here.', boxes: [{ x: 0, y: 0, w: 100, h: 10 }] }]
function plan(notes: Plan['pageNotes']): Plan {
  return { fingerprint: 'a'.repeat(64), model: 'm', promptVersion: 'p', createdAt: '', title: 't', steps: [], skippable: [], pageNotes: notes, droppedPageNotes: 0, questions: [], figures: [], volume: { split: false, reason: null, note: null, parts: [], imagePages: [], missingImagePages: [] }, sourcing: { externalKept: 0, downgradedToInference: 0, links: [] }, coverage: { total: 1, covered: 1, skippable: 0, uncovered: [] }, usage: { calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, webSearches: 0 }, repaired: false, droppedQuotes: 0 }
}
describe('verifyPageNotes', () => {
  it('keeps a verbatim anchor with offsets and boxes, drops the rest', () => {
    const { kept, dropped } = verifyPageNotes(plan([
      { id: 'note1', sentenceId: 's1', anchor: 'Attention', note: 'n', start: 0, end: 0, boxes: [] },
      { id: 'note2', sentenceId: 's1', anchor: 'missing phrase', note: 'n', start: 0, end: 0, boxes: [] },
    ]), sentences)
    expect(dropped).toBe(1)
    expect(kept[0]).toMatchObject({ start: 0, end: 9 })
    expect(kept[0].boxes[0].w).toBeGreaterThan(0)
    expect(kept[0].boxes[0].w).toBeLessThan(100)
  })

  it('places a wide-letter anchor by glyph width, not character count', () => {
    const wide: Sentence[] = [{ id: 's1', page: 1, start: 0, end: 13, text: 'iiii mmmm end', boxes: [{ x: 0, y: 0, w: 100, h: 10 }] }]
    const { kept } = verifyPageNotes(plan([
      { id: 'note1', sentenceId: 's1', anchor: 'mmmm', note: 'n', start: 0, end: 0, boxes: [] },
    ]), wide)
    // Prefix 'iiii ' is 1362 and 'mmmm' is 3112 of 6168 thousandths of an em.
    expect(kept[0].boxes).toHaveLength(1)
    expect(kept[0].boxes[0].x).toBeCloseTo((100 * 1362) / 6168)
    expect(kept[0].boxes[0].w).toBeCloseTo((100 * 3112) / 6168)
    expect(kept[0].boxes[0].x).toBeLessThan((100 * 5) / 13 - 10)
  })

  it('places a narrow-letter anchor by glyph width, not character count', () => {
    const narrow: Sentence[] = [{ id: 's1', page: 1, start: 0, end: 13, text: 'mmmm iiii end', boxes: [{ x: 0, y: 0, w: 100, h: 10 }] }]
    const { kept } = verifyPageNotes(plan([
      { id: 'note1', sentenceId: 's1', anchor: 'iiii', note: 'n', start: 0, end: 0, boxes: [] },
    ]), narrow)
    expect(kept[0].boxes).toHaveLength(1)
    expect(kept[0].boxes[0].x).toBeCloseTo((100 * (3112 + 250)) / 6168)
    expect(kept[0].boxes[0].w).toBeCloseTo((100 * 1112) / 6168)
    expect(kept[0].boxes[0].w).toBeLessThan((100 * 4) / 13 - 5)
  })

  it('places an anchor from measured character edges when the boxes have them', () => {
    const measured: Sentence[] = [{
      id: 's1', page: 1, start: 0, end: 5, text: 'ab cd',
      boxes: [{ x: 10, y: 0, w: 50, h: 10, start: 0, charEnds: [4, 8, 20, 30, 50] }],
    }]
    const { kept } = verifyPageNotes(plan([
      { id: 'note1', sentenceId: 's1', anchor: 'cd', note: 'n', start: 0, end: 0, boxes: [] },
    ]), measured)
    expect(kept[0].boxes).toEqual([{ x: 30, y: 0, w: 30, h: 10 }])
  })

  it('splits a wrapped anchor by the characters each measured box holds', () => {
    const measured: Sentence[] = [{
      id: 's1', page: 1, start: 0, end: 8, text: 'aa bb\ncc',
      boxes: [
        { x: 10, y: 100, w: 50, h: 10, start: 0, charEnds: [5, 10, 20, 35, 50] },
        { x: 10, y: 80, w: 30, h: 10, start: 6, charEnds: [10, 30] },
      ],
    }]
    const { kept } = verifyPageNotes(plan([
      { id: 'note1', sentenceId: 's1', anchor: 'bb\ncc', note: 'n', start: 0, end: 0, boxes: [] },
    ]), measured)
    expect(kept[0].boxes).toEqual([
      { x: 30, y: 100, w: 30, h: 10 },
      { x: 10, y: 80, w: 30, h: 10 },
    ])
  })

  it('gives a wrapped anchor one box per line', () => {
    const wrapped: Sentence[] = [{
      id: 's1', page: 1, start: 0, end: 5, text: 'mm ii',
      boxes: [
        { x: 10, y: 100, w: 180.6, h: 10 },
        { x: 10, y: 80, w: 55.6, h: 10 },
      ],
    }]
    const { kept } = verifyPageNotes(plan([
      { id: 'note1', sentenceId: 's1', anchor: 'mm ii', note: 'n', start: 0, end: 0, boxes: [] },
    ]), wrapped)
    expect(kept[0].boxes).toHaveLength(2)
    expect(kept[0].boxes[0]).toMatchObject({ x: 10, y: 100 })
    expect(kept[0].boxes[0].w).toBeCloseTo(180.6)
    expect(kept[0].boxes[1]).toMatchObject({ x: 10, y: 80 })
    expect(kept[0].boxes[1].w).toBeCloseTo(55.6)
  })
})
