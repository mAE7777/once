import type { ReadableTextItem } from '@/lib/types'

/** One painted glyph in page coordinates: where its advance starts and ends along the line. */
export interface PlacedGlyph {
  text: string
  x0: number
  x1: number
  y: number
}

export interface GlyphListInput {
  fnArray: ArrayLike<number>
  argsArray: ArrayLike<unknown>
  ops: Readonly<Record<string, number>>
  /** The font's glyph-space to text-space scale, 0.001 for everything but Type 3 fonts. */
  fontScale: (fontName: string) => number
}

type Matrix = readonly [number, number, number, number, number, number]

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

interface TextState {
  ctm: Matrix
  textMatrix: Matrix
  penX: number
  penY: number
  lineX: number
  lineY: number
  fontScale: number
  fontSize: number
  charSpacing: number
  wordSpacing: number
  horizontalScale: number
  leading: number
  rise: number
}

interface RawGlyph {
  unicode?: unknown
  width?: unknown
  isSpace?: unknown
}

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ]
}

/** pdf.js hands a matrix over as six arguments, an array, or an indexed typed array. */
function toMatrix(args: unknown): Matrix | null {
  if (!Array.isArray(args)) return null
  const source = (args.length === 6 ? args : args[0]) as ArrayLike<unknown> | null | undefined
  if (!source) return null
  const values = [0, 1, 2, 3, 4, 5].map((index) => source[index])
  if (!values.every((value) => typeof value === 'number')) return null
  return values as unknown as Matrix
}

function numberArg(args: unknown, index = 0): number {
  const value = Array.isArray(args) ? args[index] : undefined
  return typeof value === 'number' ? value : 0
}

function isSpace(text: string): boolean {
  return text.trim().length === 0
}

/**
 * Replays the text operators of a page's operator list, following the PDF text state, so every
 * glyph comes out with its real position, kerning, word spacing and horizontal scale included.
 */
export function readPlacedGlyphs({ fnArray, argsArray, ops, fontScale }: GlyphListInput): PlacedGlyph[] {
  const glyphs: PlacedGlyph[] = []
  const stack: TextState[] = []
  let state: TextState = {
    ctm: IDENTITY,
    textMatrix: IDENTITY,
    penX: 0,
    penY: 0,
    lineX: 0,
    lineY: 0,
    fontScale: 0.001,
    fontSize: 0,
    charSpacing: 0,
    wordSpacing: 0,
    horizontalScale: 1,
    leading: 0,
    rise: 0,
  }

  const moveText = (x: number, y: number) => {
    state.lineX += x
    state.lineY += y
    state.penX = state.lineX
    state.penY = state.lineY
  }

  const showText = (run: unknown) => {
    if (!Array.isArray(run)) return
    const world = multiply(state.ctm, state.textMatrix)
    for (const entry of run as (number | RawGlyph | null)[]) {
      if (typeof entry === 'number') {
        state.penX -= (entry / 1000) * state.fontSize * state.horizontalScale
        continue
      }
      if (!entry) continue
      const width = typeof entry.width === 'number' ? entry.width : 0
      const advance = width * state.fontScale * state.fontSize * state.horizontalScale
      const text = typeof entry.unicode === 'string' ? entry.unicode : ''
      if (text) {
        const baseline = state.penY + state.rise
        glyphs.push({
          text,
          x0: world[0] * state.penX + world[2] * baseline + world[4],
          x1: world[0] * (state.penX + advance) + world[2] * baseline + world[4],
          y: world[1] * state.penX + world[3] * baseline + world[5],
        })
      }
      const spacing = state.charSpacing + (entry.isSpace ? state.wordSpacing : 0)
      state.penX += advance + spacing * state.horizontalScale
    }
  }

  for (let index = 0; index < fnArray.length; index += 1) {
    const fn = fnArray[index]
    const args = argsArray[index]
    switch (fn) {
      case ops.save:
        stack.push({ ...state })
        break
      case ops.restore:
        state = stack.pop() ?? state
        break
      case ops.transform: {
        const matrix = toMatrix(args)
        if (matrix) state.ctm = multiply(state.ctm, matrix)
        break
      }
      case ops.paintFormXObjectBegin: {
        stack.push({ ...state })
        const matrix = toMatrix(Array.isArray(args) ? [args[0]] : null)
        if (matrix) state.ctm = multiply(state.ctm, matrix)
        break
      }
      case ops.paintFormXObjectEnd:
        state = stack.pop() ?? state
        break
      case ops.beginText:
        state.textMatrix = IDENTITY
        state.penX = 0
        state.penY = 0
        state.lineX = 0
        state.lineY = 0
        break
      case ops.setFont: {
        const name = Array.isArray(args) ? args[0] : undefined
        state.fontScale = typeof name === 'string' ? fontScale(name) : 0.001
        state.fontSize = numberArg(args, 1)
        break
      }
      case ops.setCharSpacing:
        state.charSpacing = numberArg(args)
        break
      case ops.setWordSpacing:
        state.wordSpacing = numberArg(args)
        break
      case ops.setHScale:
        state.horizontalScale = numberArg(args) / 100
        break
      case ops.setLeading:
        state.leading = numberArg(args)
        break
      case ops.setTextRise:
        state.rise = numberArg(args)
        break
      case ops.moveText:
        moveText(numberArg(args, 0), numberArg(args, 1))
        break
      case ops.setLeadingMoveText:
        state.leading = -numberArg(args, 1)
        moveText(numberArg(args, 0), numberArg(args, 1))
        break
      case ops.nextLine:
        moveText(0, state.leading)
        break
      case ops.setTextMatrix: {
        const matrix = toMatrix(args)
        if (matrix) state.textMatrix = matrix
        state.penX = 0
        state.penY = 0
        state.lineX = 0
        state.lineY = 0
        break
      }
      case ops.showText:
      case ops.showSpacedText:
        showText(Array.isArray(args) ? args[0] : null)
        break
      case ops.nextLineShowText:
        moveText(0, state.leading)
        showText(Array.isArray(args) ? args[0] : null)
        break
      case ops.nextLineSetSpacingShowText:
        state.wordSpacing = numberArg(args, 0)
        state.charSpacing = numberArg(args, 1)
        moveText(0, state.leading)
        showText(Array.isArray(args) ? args[2] : null)
        break
      default:
        break
    }
  }
  return glyphs
}

/**
 * How many characters of `str` at `at` this glyph paints, or 0 when it paints something else.
 * A ligature glyph counts as every letter it stands for, in either direction of normalization.
 */
function charsForGlyph(text: string, str: string, at: number): number {
  if (str.startsWith(text, at)) return text.length
  const normalized = text.normalize('NFKC')
  if (str.startsWith(normalized, at)) return normalized.length
  return str[at].normalize('NFKC') === normalized ? 1 : 0
}

const POSITION_TOLERANCE = 1
const LINE_TOLERANCE = 1.5
const WIDTH_TOLERANCE = 1

function findFirstGlyph(item: ReadableTextItem, firstChar: number, glyphs: readonly PlacedGlyph[], from: number): number {
  const fits = (glyph: PlacedGlyph) => {
    if (Math.abs(glyph.y - item.y) > LINE_TOLERANCE) return false
    if (charsForGlyph(glyph.text, item.str, firstChar) === 0) return false
    if (firstChar === 0) return Math.abs(glyph.x0 - item.x) <= POSITION_TOLERANCE
    return glyph.x0 >= item.x - POSITION_TOLERANCE && glyph.x0 <= item.x + item.w + POSITION_TOLERANCE
  }
  for (let index = from; index < glyphs.length; index += 1) {
    if (fits(glyphs[index])) return index
  }
  for (let index = 0; index < from; index += 1) {
    if (fits(glyphs[index])) return index
  }
  return -1
}

function roundEnds(ends: readonly number[]): number[] {
  const rounded: number[] = []
  let previous = 0
  for (const end of ends) {
    previous = Math.max(previous, Math.round(end * 100) / 100)
    rounded.push(previous)
  }
  return rounded
}

/**
 * Lines one text item's characters up with the glyphs that paint them. Returns the right edge of
 * every UTF-16 unit of the string, relative to the item's start, and the glyph to carry on from;
 * or null when the two cannot be lined up or disagree with the item's real width.
 */
function alignItem(
  item: ReadableTextItem,
  glyphs: readonly PlacedGlyph[],
  from: number,
): { charEnds: number[]; next: number } | null {
  const { str } = item
  const firstChar = str.search(/\S/)
  if (firstChar === -1) return { charEnds: Array.from(str, () => Math.round(item.w * 100) / 100), next: from }

  const first = findFirstGlyph(item, firstChar, glyphs, from)
  if (first === -1) return null

  const ends: number[] = new Array(str.length).fill(0)
  let waiting: number[] = []
  let glyphIndex = first
  let at = 0
  let lastGlyphEnd = 0
  while (at < str.length) {
    if (isSpace(str[at])) {
      // A space glyph, or a gap pdf.js wrote as a space: either way it runs up to the next glyph.
      if (at >= firstChar && glyphIndex < glyphs.length && isSpace(glyphs[glyphIndex].text)) glyphIndex += 1
      waiting.push(at)
      at += 1
      continue
    }
    while (glyphIndex < glyphs.length && isSpace(glyphs[glyphIndex].text)) glyphIndex += 1
    if (glyphIndex >= glyphs.length) return null
    const glyph = glyphs[glyphIndex]
    const count = charsForGlyph(glyph.text, str, at)
    if (count === 0) return null
    for (const space of waiting) ends[space] = glyph.x0 - item.x
    waiting = []
    for (let part = 1; part <= count; part += 1) {
      ends[at + part - 1] = glyph.x0 + ((glyph.x1 - glyph.x0) * part) / count - item.x
    }
    lastGlyphEnd = ends[at + count - 1]
    at += count
    glyphIndex += 1
  }
  for (const space of waiting) ends[space] = item.w

  const fallsShort = waiting.length === 0 && item.w - lastGlyphEnd > WIDTH_TOLERANCE
  if (fallsShort || lastGlyphEnd - item.w > WIDTH_TOLERANCE) return null
  return { charEnds: roundEnds(ends), next: glyphIndex }
}

/**
 * Gives each text item the measured right edge of every character. An item that cannot be lined up
 * with its glyphs keeps no measurements and is placed from the shared width table instead.
 */
export function attachCharEnds(items: readonly ReadableTextItem[], glyphs: readonly PlacedGlyph[]): void {
  let from = 0
  for (const item of items) {
    if (!item.str) continue
    const aligned = alignItem(item, glyphs, from)
    if (!aligned) continue
    item.charEnds = aligned.charEnds
    from = aligned.next
  }
}
