import { PDFDocument, StandardFonts, setCharacterSqueeze, setWordSpacing, type PDFFont } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import type { Plan, ReadableDocument, ReadablePage, ReadableTextItem } from '@/lib/types'
import { buildSentenceDocument, spanWithinItem } from '@/sentences/sentences'
import { verifyPageNotes } from '@/verify/verify'
import { attachCharEnds, readPlacedGlyphs, type PlacedGlyph } from './advances'
import { extractPdfPages } from './pdf'

const FINGERPRINT = 'c'.repeat(64)
const FONT_SIZE = 18
const LEFT = 50

interface Spacing {
  word?: number
  horizontalPercent?: number
}

async function linePdf(line: string, spacing: Spacing = {}): Promise<{ bytes: Uint8Array; font: PDFFont }> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([900, 792])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  if (spacing.word !== undefined) page.pushOperators(setWordSpacing(spacing.word))
  if (spacing.horizontalPercent !== undefined) page.pushOperators(setCharacterSqueeze(spacing.horizontalPercent))
  page.drawText(line, { x: LEFT, y: 700, size: FONT_SIZE, font })
  return { bytes: await doc.save(), font }
}

/** The true left and right edge of a word on the line, worked out from the font's own widths. */
function trueEdges(line: string, word: string, font: PDFFont, spacing: Spacing = {}) {
  const scale = (spacing.horizontalPercent ?? 100) / 100
  const advance = (ch: string) => (font.widthOfTextAtSize(ch, FONT_SIZE) + (ch === ' ' ? spacing.word ?? 0 : 0)) * scale
  const start = line.indexOf(word)
  let left = LEFT
  for (const ch of line.slice(0, start)) left += advance(ch)
  let right = left
  for (const ch of word) right += font.widthOfTextAtSize(ch, FONT_SIZE) * scale
  // Word spacing inside the word itself only matters for phrases, which these tests do not measure.
  return { left, right }
}

function documentOf(pages: ReadablePage[]): ReadableDocument {
  return {
    fingerprint: FINGERPRINT,
    kind: 'pdf',
    pageCount: pages.length,
    fullText: pages.map((page) => page.text).join('\n'),
    pages,
  }
}

function planWith(sentenceId: string, anchor: string): Plan {
  return {
    pageNotes: [{ id: 'note1', sentenceId, anchor, note: 'n', start: 0, end: 0, boxes: [] }],
  } as unknown as Plan
}

describe('word positions measured from a generated PDF', () => {
  const line = 'Illicit lilt MMMWWW tiny ill WWWMMM ends here. Thin illicit lilt starts now.'

  it('measures every character and agrees with the width pdf.js reports', async () => {
    const { bytes } = await linePdf(line)
    const [page] = await extractPdfPages(bytes, FINGERPRINT)
    const [item] = page.items.filter((entry) => entry.str.trim())
    expect(item.str).toBe(line)
    expect(item.charEnds).toHaveLength(line.length)
    expect(Math.abs((item.charEnds as number[]).at(-1)! - item.w)).toBeLessThan(0.02)
    const ends = item.charEnds as number[]
    for (let i = 1; i < ends.length; i += 1) expect(ends[i]).toBeGreaterThanOrEqual(ends[i - 1])
  })

  it.each(['WWWMMM', 'MMMWWW', 'ill', 'tiny', 'lilt'])('boxes the word %s within a tenth of a point', async (word) => {
    const { bytes, font } = await linePdf(line)
    const pages = await extractPdfPages(bytes, FINGERPRINT)
    const document = buildSentenceDocument(documentOf(pages))
    const { kept } = verifyPageNotes(planWith('s1', word), document.sentences)
    expect(kept).toHaveLength(1)
    expect(kept[0].boxes).toHaveLength(1)
    const box = kept[0].boxes[0]
    const edges = trueEdges(line, word, font)
    expect(Math.abs(box.x - edges.left)).toBeLessThan(0.1)
    expect(Math.abs(box.x + box.w - edges.right)).toBeLessThan(0.1)
  })

  it('beats the width table where the table is visibly wrong', async () => {
    const { bytes, font } = await linePdf(line)
    const [page] = await extractPdfPages(bytes, FINGERPRINT)
    const [item] = page.items.filter((entry) => entry.str.trim())
    const start = line.indexOf('WWWMMM')
    const edges = trueEdges(line, 'WWWMMM', font)
    const fromTable = spanWithinItem(item.str, item.x, item.w, start, start + 6)
    const measured = spanWithinItem(item.str, item.x, item.w, start, start + 6, item.charEnds)
    expect(Math.abs(fromTable.x + fromTable.w - edges.right)).toBeGreaterThan(1)
    expect(Math.abs(measured.x + measured.w - edges.right)).toBeLessThan(0.1)
  })

  it('ends a mid-line sentence box at the true end of its last word', async () => {
    const { bytes, font } = await linePdf(line)
    const pages = await extractPdfPages(bytes, FINGERPRINT)
    const { sentences } = buildSentenceDocument(documentOf(pages))
    expect(sentences.map((sentence) => sentence.text)).toEqual([
      'Illicit lilt MMMWWW tiny ill WWWMMM ends here.',
      'Thin illicit lilt starts now.',
    ])
    const first = sentences[0].boxes[0]
    const second = sentences[1].boxes[0]
    expect(Math.abs(first.x + first.w - trueEdges(line, 'here.', font).right)).toBeLessThan(0.1)
    expect(Math.abs(second.x - trueEdges(line, 'Thin', font).left)).toBeLessThan(0.1)
  })

  it('follows word spacing and horizontal scaling set in the page', async () => {
    const spacing: Spacing = { word: 6, horizontalPercent: 115 }
    const { bytes, font } = await linePdf(line, spacing)
    const pages = await extractPdfPages(bytes, FINGERPRINT)
    const document = buildSentenceDocument(documentOf(pages))
    const { kept } = verifyPageNotes(planWith('s1', 'WWWMMM'), document.sentences)
    const box = kept[0].boxes[0]
    const edges = trueEdges(line, 'WWWMMM', font, spacing)
    expect(Math.abs(box.x - edges.left)).toBeLessThan(0.1)
    expect(Math.abs(box.x + box.w - edges.right)).toBeLessThan(0.1)
  })
})

function item(str: string, x: number, w: number, y = 100): ReadableTextItem {
  return { str, x, y, w, h: 10 }
}

function glyph(text: string, x0: number, x1: number, y = 100): PlacedGlyph {
  return { text, x0, x1, y }
}

describe('attachCharEnds', () => {
  it('splits a ligature glyph across the letters it stands for', () => {
    const items = [item('define', 10, 30)]
    attachCharEnds(items, [
      glyph('d', 10, 15),
      glyph('e', 15, 20),
      glyph('ﬁ', 20, 30),
      glyph('n', 30, 35),
      glyph('e', 35, 40),
    ])
    expect(items[0].charEnds).toEqual([5, 10, 15, 20, 25, 30])
  })

  it('accepts a ligature kept as one character in the string', () => {
    const items = [item('deﬁ', 10, 20)]
    attachCharEnds(items, [glyph('d', 10, 15), glyph('e', 15, 20), glyph('fi', 20, 30)])
    expect(items[0].charEnds).toEqual([5, 10, 20])
  })

  it('counts a character outside the basic plane as two string units', () => {
    const math = '\u{1D465}'
    const items = [item(`a${math}b`, 0, 15)]
    attachCharEnds(items, [glyph('a', 0, 5), glyph(math, 5, 10), glyph('b', 10, 15)])
    expect(items[0].charEnds).toEqual([5, 7.5, 10, 15])
  })

  it('runs a space with no glyph of its own up to the next word', () => {
    const items = [item('ab cd', 0, 26)]
    attachCharEnds(items, [glyph('a', 0, 5), glyph('b', 5, 10), glyph('c', 16, 21), glyph('d', 21, 26)])
    expect(items[0].charEnds).toEqual([5, 10, 16, 21, 26])
  })

  it('runs a space glyph up to the next word, word spacing included', () => {
    const items = [item('a b', 0, 20)]
    attachCharEnds(items, [glyph('a', 0, 5), glyph(' ', 5, 8), glyph('b', 15, 20)])
    expect(items[0].charEnds).toEqual([5, 15, 20])
  })

  it('runs a trailing space to the item width and measures a space-only item', () => {
    const items = [item('a ', 0, 12), item(' ', 12, 4)]
    attachCharEnds(items, [glyph('a', 0, 5)])
    expect(items[0].charEnds).toEqual([5, 12])
    expect(items[1].charEnds).toEqual([4])
  })

  it('leaves an item unmeasured when its characters do not match the glyphs, and recovers on the next', () => {
    const items = [item('xyz', 0, 15), item('ok', 20, 10)]
    attachCharEnds(items, [
      glyph('x', 0, 5),
      glyph('q', 5, 10),
      glyph('z', 10, 15),
      glyph('o', 20, 25),
      glyph('k', 25, 30),
    ])
    expect(items[0].charEnds).toBeUndefined()
    expect(items[1].charEnds).toEqual([5, 10])
  })

  it('leaves an item unmeasured when the glyphs disagree with its real width', () => {
    const items = [item('ab', 0, 30)]
    attachCharEnds(items, [glyph('a', 0, 5), glyph('b', 5, 10)])
    expect(items[0].charEnds).toBeUndefined()
  })

  it('leaves rotated text unmeasured', () => {
    const items = [item('ab', 30, 10, 100)]
    attachCharEnds(items, [glyph('a', 30, 30, 100), glyph('b', 30, 30, 105)])
    expect(items[0].charEnds).toBeUndefined()
  })

  it('does not pick up the same letters from another line', () => {
    const items = [item('ab', 0, 10, 100)]
    attachCharEnds(items, [glyph('a', 0, 5, 50), glyph('b', 5, 10, 50)])
    expect(items[0].charEnds).toBeUndefined()
  })
})

describe('readPlacedGlyphs', () => {
  const ops = {
    save: 1,
    restore: 2,
    transform: 3,
    beginText: 4,
    setFont: 5,
    setTextMatrix: 6,
    moveText: 7,
    showText: 8,
    setCharSpacing: 9,
    paintFormXObjectBegin: 10,
    paintFormXObjectEnd: 11,
    setHScale: 12,
    setLeading: 13,
    nextLine: 14,
    setTextRise: 15,
    setWordSpacing: 16,
  }
  const fontScale = () => 0.001
  const letter = (unicode: string, width: number, isSpace = false) => ({ unicode, width, isSpace })

  function read(steps: [number, unknown][]) {
    return readPlacedGlyphs({ fnArray: steps.map((s) => s[0]), argsArray: steps.map((s) => s[1]), ops, fontScale })
  }

  it('moves the pen by glyph widths and spacing adjustments', () => {
    const glyphs = read([
      [ops.beginText, null],
      [ops.setFont, ['f', 10]],
      [ops.moveText, [100, 200]],
      [ops.showText, [[letter('a', 500), -1000, letter('b', 500)]]],
    ])
    expect(glyphs[0]).toEqual({ text: 'a', x0: 100, x1: 105, y: 200 })
    expect(glyphs[1]).toEqual({ text: 'b', x0: 115, x1: 120, y: 200 })
  })

  it('stretches widths by a text matrix given as an indexed array', () => {
    const glyphs = read([
      [ops.beginText, null],
      [ops.setFont, ['f', 10]],
      [ops.setTextMatrix, [Float32Array.of(2, 0, 0, 1, 50, 60)]],
      [ops.showText, [[letter('a', 500), letter('b', 500)]]],
    ])
    expect(glyphs[0]).toEqual({ text: 'a', x0: 50, x1: 60, y: 60 })
    expect(glyphs[1]).toEqual({ text: 'b', x0: 60, x1: 70, y: 60 })
  })

  it('applies the page transform and forgets it after a restore', () => {
    const glyphs = read([
      [ops.save, null],
      [ops.transform, [2, 0, 0, 2, 10, 20]],
      [ops.beginText, null],
      [ops.setFont, ['f', 10]],
      [ops.showText, [[letter('a', 500)]]],
      [ops.restore, null],
      [ops.beginText, null],
      [ops.showText, [[letter('b', 500)]]],
    ])
    expect(glyphs[0]).toEqual({ text: 'a', x0: 10, x1: 20, y: 20 })
    expect(glyphs[1].x0).toBe(0)
    expect(glyphs[1].y).toBe(0)
  })

  it('places text inside a form by the form matrix', () => {
    const glyphs = read([
      [ops.paintFormXObjectBegin, [Float32Array.of(1, 0, 0, 1, 30, 40), null]],
      [ops.beginText, null],
      [ops.setFont, ['f', 10]],
      [ops.showText, [[letter('a', 500)]]],
      [ops.paintFormXObjectEnd, null],
      [ops.beginText, null],
      [ops.showText, [[letter('b', 500)]]],
    ])
    expect(glyphs[0].x0).toBe(30)
    expect(glyphs[0].y).toBe(40)
    expect(glyphs[1].x0).toBe(0)
  })

  it('applies char spacing, word spacing, horizontal scale, leading and rise', () => {
    const glyphs = read([
      [ops.beginText, null],
      [ops.setFont, ['f', 10]],
      [ops.setHScale, [200]],
      [ops.setCharSpacing, [1]],
      [ops.setWordSpacing, [3]],
      [ops.setLeading, [-12]],
      [ops.moveText, [0, 100]],
      [ops.nextLine, null],
      [ops.setTextRise, [2]],
      [ops.showText, [[letter(' ', 500, true), letter('a', 500)]]],
    ])
    expect(glyphs[0]).toEqual({ text: ' ', x0: 0, x1: 10, y: 90 })
    expect(glyphs[1]).toEqual({ text: 'a', x0: 18, x1: 28, y: 90 })
  })
})
