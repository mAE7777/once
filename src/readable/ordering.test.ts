import { describe, expect, it } from 'vitest'
import type { ReadableTextItem } from '@/lib/types'
import { buildPageText, detectColumnSplit, orderItemsForReading } from './ordering'

function item(str: string, x: number, y: number, w: number, h = 10): ReadableTextItem {
  return { str, x, y, w, h }
}

describe('buildPageText', () => {
  it('reads a single column top to bottom and joins gapped words with a space', () => {
    const items = [
      item('second', 50, 680, 50),
      item('line', 105, 680, 35),
      item('first', 50, 700, 40),
      item('line', 95, 700, 35),
    ]

    expect(buildPageText(items, 600)).toBe('first line\nsecond line')
  })

  it('reads the full left column before the right column', () => {
    const items = [
      item('Right one', 350, 700, 120),
      item('Left two', 50, 680, 110),
      item('Right two', 350, 680, 120),
      item('Left one', 50, 700, 110),
    ]

    expect(buildPageText(items, 600)).toBe('Left one\nLeft two\nRight one\nRight two')
    expect(orderItemsForReading(items, 600).map((entry) => entry.str)).toEqual([
      'Left one',
      'Left two',
      'Right one',
      'Right two',
    ])
  })

  it('does not split a page whose lines cross the middle', () => {
    const items = [
      item('A wide opening line that crosses the middle', 50, 700, 480),
      item('Another wide line on the same page', 50, 680, 470),
      item('A third wide line below it', 50, 660, 460),
      item('A fourth wide line at the bottom', 50, 640, 480),
    ]

    expect(detectColumnSplit(items, 600)).toBeNull()
    expect(buildPageText(items, 600)).toBe(
      'A wide opening line that crosses the middle\nAnother wide line on the same page\nA third wide line below it\nA fourth wide line at the bottom',
    )
  })
})
