import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  ReadableDocument,
  ReadablePage,
  ReadableTextItem,
  Sentence,
  SentenceBox,
  SentenceDocument,
} from '@/lib/types'
import { orderItemsForReading } from '@/readable/ordering'

export class SentencesError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SentencesError'
  }
}

export class SentenceDocumentNotFoundError extends SentencesError {
  constructor(message = 'This document was not found.') {
    super(message)
    this.name = 'SentenceDocumentNotFoundError'
  }
}

export class ReadableNotBuiltError extends SentencesError {
  constructor(message = 'This document has no readable text yet. Generate the readable text first, then split it into sentences.') {
    super(message)
    this.name = 'ReadableNotBuiltError'
  }
}

export interface SentenceSpan {
  start: number
  end: number
  text: string
}

// Times-Roman AFM widths, in thousandths of an em, for the letters.
const LETTER_WIDTHS: Record<string, number> = {
  a: 444, b: 500, c: 444, d: 500, e: 444, f: 333, g: 500, h: 500, i: 278, j: 278,
  k: 500, l: 278, m: 778, n: 500, o: 500, p: 500, q: 500, r: 333, s: 389, t: 278,
  u: 500, v: 500, w: 722, x: 500, y: 500, z: 444,
  A: 722, B: 667, C: 667, D: 722, E: 611, F: 556, G: 722, H: 722, I: 333, J: 389,
  K: 722, L: 611, M: 889, N: 722, O: 722, P: 556, Q: 722, R: 667, S: 556, T: 611,
  U: 722, V: 722, W: 944, X: 722, Y: 722, Z: 611,
}

const PUNCT_WIDTHS: Record<string, number> = {
  ' ': 250, '!': 333, '"': 408, '#': 500, $: 500, '%': 833, '&': 778, "'": 180,
  '(': 333, ')': 333, '*': 389, '+': 564, ',': 250, '-': 333, '.': 250, '/': 278,
  ':': 278, ';': 278, '<': 564, '=': 564, '>': 564, '?': 444, '@': 921, '[': 333,
  '\\': 278, ']': 333, '^': 469, _: 556, '`': 333, '{': 480, '|': 200, '}': 480, '~': 541,
}

export function glyphWidth(ch: string): number {
  if (!ch || ch === '\n' || ch === '\r' || ch === '\t') return ch === '\t' ? 250 : 0
  const letter = LETTER_WIDTHS[ch]
  if (letter !== undefined) return letter
  if (ch >= '0' && ch <= '9') return 500
  const punct = PUNCT_WIDTHS[ch]
  if (punct !== undefined) return punct
  const code = ch.codePointAt(0) ?? 0
  if ((code >= 0x2e80 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7ff) || (code >= 0xf900 && code <= 0xfaff)) return 1000
  return 500
}

function widthOf(text: string, from: number, to: number): number {
  let total = 0
  for (let i = from; i < to; i += 1) total += glyphWidth(text[i])
  return total
}

/**
 * The horizontal span, in PDF points, of characters [startChar, endChar) inside
 * one text item. The item's measured character edges are used when it has one for
 * every character. Otherwise widths come from glyph widths, not character counts, and
 * only their ratio to the whole item is used, so itemW stays authoritative at any size.
 */
export function spanWithinItem(
  itemStr: string,
  itemX: number,
  itemW: number,
  startChar: number,
  endChar: number,
  charEnds?: readonly number[],
): { x: number; w: number } {
  const length = itemStr.length
  const start = Math.min(Math.max(startChar, 0), length)
  const end = Math.min(Math.max(endChar, start), length)
  if (charEnds && length > 0 && charEnds.length === length) {
    const left = start > 0 ? charEnds[start - 1] : 0
    const right = end > 0 ? charEnds[end - 1] : 0
    return { x: itemX + left, w: Math.max(right - left, 0) }
  }
  const total = widthOf(itemStr, 0, length)
  if (total <= 0 || itemW === 0) return { x: itemX, w: 0 }
  const prefix = widthOf(itemStr, 0, start)
  const span = widthOf(itemStr, start, end)
  return { x: itemX + (itemW * prefix) / total, w: (itemW * span) / total }
}

const TERMINATORS = new Set(['.', '?', '!', '\u3002', '\uff01', '\uff1f', '‽', '…'])

const STRONG_ABBREVIATION =
  /(?:^|[\s(\["“‘])(?:figs?|eqs?|eqns?|refs?|tabs?|dr|mr|mrs|ms|prof|sr|jr|vs|cf|viz|approx|dept|univ)\.$/i
const NUMBER_ABBREVIATION = /(?:^|[\s(\["“‘])(?:no|nos|vol|pp?|sec|secs|chap)\.$/i
const ET_AL = /\bet\s+al\.$/i
const IE_EG = /(?:^|[\s(\["“‘])(?:i\.e|e\.g)\.$/i
const SINGLE_INITIAL = /(?:^|[\s(\["“‘])\p{Lu}\.$/u
const CITATION_ONLY = /^(?:\[[^\]]*\]|\([^)]*\))\s*[.!?\u3002\uff01\uff1f]*$/
const CLOSING_ONLY = /^["'”’)\]}>»]+[.!?\u3002\uff01\uff1f]*$/

const FUNCTION_WORDS = new Set([
  'the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'with', 'without', 'by', 'at',
  'from', 'as', 'and', 'or', 'but', 'nor', 'that', 'which', 'who', 'whom', 'whose',
  'when', 'where', 'while', 'if', 'than', 'into', 'onto', 'over', 'under', 'between',
  'among', 'through', 'during', 'before', 'after', 'about', 'against', 'per', 'via',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'has', 'have', 'had', 'do',
  'does', 'did', 'will', 'would', 'can', 'could', 'should', 'may', 'might', 'must',
  'shall', 'its', 'their', 'his', 'her', 'our', 'your', 'this', 'these', 'those',
  'not', 'no', 'more', 'most', 'less', 'also', 'like',
])

interface BracketBalance {
  round: number
  square: number
  curly: number
}

function addToBalance(balance: BracketBalance, text: string): void {
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '(') balance.round += 1
    else if (ch === ')') balance.round -= 1
    else if (ch === '[') balance.square += 1
    else if (ch === ']') balance.square -= 1
    else if (ch === '{') balance.curly += 1
    else if (ch === '}') balance.curly -= 1
  }
}

function coreBeforeEnd(text: string): string {
  let core = text
  for (;;) {
    const trimmed = core.trimEnd()
    const citation = trimmed.match(/(\[[^\[\]]*\]|\([^()]*\d[^()]*\))$/)
    if (citation) {
      core = trimmed.slice(0, trimmed.length - citation[0].length)
      continue
    }
    const last = trimmed[trimmed.length - 1]
    if (last !== undefined && `"'”’»>)]}`.includes(last)) {
      core = trimmed.slice(0, trimmed.length - 1)
      continue
    }
    return trimmed
  }
}

function endsWithTerminator(text: string): boolean {
  const core = coreBeforeEnd(text)
  const last = core[core.length - 1]
  return last !== undefined && TERMINATORS.has(last)
}

function lastWord(text: string): string | null {
  const match = text.match(/(\p{L}[\p{L}'’-]*)$/u)
  return match ? match[1] : null
}

function wordCount(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  return trimmed.split(/\s+/).length
}

function shouldMerge(previous: string, next: string, balance: BracketBalance): boolean {
  const prev = previous.trimEnd()
  const following = next.trim()
  if (!prev || !following) return true

  if (/^[\])}>”’»]/.test(following)) return true
  if (/^[.,;:!?\uff0c\u3002\uff1b\uff1a\uff01\uff1f\u3001]/.test(following)) return true
  if (CITATION_ONLY.test(following)) return true
  if ((following.startsWith('"') || following.startsWith("'")) && CLOSING_ONLY.test(following)) {
    return true
  }
  if (balance.round > 0 || balance.square > 0 || balance.curly > 0) return true
  if (/[(\[{<“‘]$/.test(prev)) return true

  const nextStartsDigit = /^\d/.test(following)
  const nextStartsLower = /^\p{Ll}/u.test(following)

  if (STRONG_ABBREVIATION.test(prev) || ET_AL.test(prev) || IE_EG.test(prev)) return true
  if (NUMBER_ABBREVIATION.test(prev) && nextStartsDigit) return true
  if (/\betc\.$/i.test(prev) && (nextStartsLower || nextStartsDigit)) return true
  if (SINGLE_INITIAL.test(prev)) return true
  if (/\d\.$/.test(prev) && nextStartsDigit) return true
  if (/\d$/.test(prev) && /^\.\d/.test(following)) return true
  if (/(\.\.\.|…)$/.test(coreBeforeEnd(prev)) && nextStartsLower) return true

  if (endsWithTerminator(prev)) return false

  if (/[-,;:\u3001\uff0c\uff1a\uff1b/\\–—]$/.test(prev)) return true

  const word = lastWord(prev)
  const lowerWord = word ? word.toLowerCase() : null
  if (lowerWord && FUNCTION_WORDS.has(lowerWord)) return true

  const firstToken = following.match(/^(\S+)/)?.[1] ?? ''
  const lastToken = prev.match(/(\S+)$/)?.[1] ?? ''

  if (nextStartsLower) {
    if (firstToken.includes('@') || firstToken.includes('://')) return false
    return true
  }

  const count = wordCount(prev)
  const prevEndsDigit = /\d$/.test(prev)
  const prevLastWordStartsLower = word !== null && /^\p{Ll}/u.test(word)

  if (nextStartsDigit) {
    return prevLastWordStartsLower || prevEndsDigit || count >= 4
  }

  if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(following)) {
    if (prev.length >= 12) return true
    return prevLastWordStartsLower && count >= 3
  }

  if (/^[\p{Lu}(\["“‘]/u.test(following)) {
    if (lastToken.includes('@') || lastToken.includes('://')) return false
    if (prevLastWordStartsLower && (count >= 3 || prev.length >= 20)) return true
    if (prevEndsDigit && count >= 3) return true
    return false
  }

  return false
}

export function segmentPageText(text: string): SentenceSpan[] {
  if (!text) return []
  const segmenter = new Intl.Segmenter(['en', 'zh'], { granularity: 'sentence' })
  const raw: { start: number; end: number }[] = []
  for (const part of segmenter.segment(text)) {
    raw.push({ start: part.index, end: part.index + part.segment.length })
  }
  if (raw.length === 0) return []

  const merged: { start: number; end: number }[] = []
  let currentStart = raw[0].start
  let currentEnd = raw[0].end
  const balance: BracketBalance = { round: 0, square: 0, curly: 0 }
  addToBalance(balance, text.slice(currentStart, currentEnd))

  for (let i = 1; i < raw.length; i += 1) {
    const piece = raw[i]
    const previous = text.slice(currentStart, currentEnd)
    const next = text.slice(piece.start, piece.end)
    if (shouldMerge(previous, next, balance)) {
      currentEnd = piece.end
      addToBalance(balance, next)
    } else {
      merged.push({ start: currentStart, end: currentEnd })
      currentStart = piece.start
      currentEnd = piece.end
      balance.round = 0
      balance.square = 0
      balance.curly = 0
      addToBalance(balance, next)
    }
  }
  merged.push({ start: currentStart, end: currentEnd })

  const spans: SentenceSpan[] = []
  for (const span of merged) {
    let { start, end } = span
    while (start < end && /\s/.test(text[start])) start += 1
    while (end > start && /\s/.test(text[end - 1])) end -= 1
    if (start >= end) continue
    spans.push({ start, end, text: text.slice(start, end) })
  }
  return spans
}

interface LocatedItem {
  item: ReadableTextItem
  start: number
  end: number
}

function alignItems(items: readonly ReadableTextItem[], text: string): LocatedItem[] {
  const located: LocatedItem[] = []
  let offset = 0
  for (const item of items) {
    if (!item.str) continue
    const found = text.indexOf(item.str, offset)
    if (found === -1) continue
    located.push({ item, start: found, end: found + item.str.length })
    offset = found + item.str.length
  }
  return located
}

function locateItems(page: ReadablePage): LocatedItem[] {
  if (page.items.length === 0) return []
  const asStored = alignItems(page.items, page.text)
  const inReadingOrder = alignItems(orderItemsForReading(page.items, page.width), page.text)
  return inReadingOrder.length >= asStored.length ? inReadingOrder : asStored
}

function roundPoints(value: number): number {
  return Math.round(value * 100) / 100
}

/** The character edges of two boxes joined into one that starts at x. Text between them, such as a joining space, runs up to the second box. */
function joinCharEnds(first: SentenceBox, second: SentenceBox, x: number): number[] | null {
  if (!first.charEnds || !second.charEnds || first.start === undefined || second.start === undefined) return null
  const between = Math.max(second.start - (first.start + first.charEnds.length), 0)
  return [
    ...first.charEnds.map((end) => roundPoints(end + first.x - x)),
    ...new Array<number>(between).fill(roundPoints(second.x - x)),
    ...second.charEnds.map((end) => roundPoints(end + second.x - x)),
  ]
}

function mergeBoxes(boxes: readonly SentenceBox[]): SentenceBox[] {
  const merged: SentenceBox[] = []
  for (const box of boxes) {
    const current = merged[merged.length - 1]
    if (!current) {
      merged.push({ ...box })
      continue
    }
    const height = Math.max(Math.abs(box.h), Math.abs(current.h), 1)
    const sameLine = Math.abs(box.y - current.y) <= Math.max(2, height * 0.5)
    const gap = Math.max(current.x - (box.x + box.w), box.x - (current.x + current.w))
    const smallGap = gap <= Math.max(10, height)
    if (sameLine && smallGap) {
      const x = Math.min(current.x, box.x)
      const y = Math.min(current.y, box.y)
      const right = Math.max(current.x + current.w, box.x + box.w)
      const top = Math.max(current.y + current.h, box.y + box.h)
      const charEnds = joinCharEnds(current, box, x)
      current.x = x
      current.y = y
      current.w = right - x
      current.h = top - y
      if (charEnds) current.charEnds = charEnds
    } else {
      merged.push({ ...box })
    }
  }
  return merged
}

function boxesForSpan(located: readonly LocatedItem[], start: number, end: number): SentenceBox[] {
  const boxes: SentenceBox[] = []
  // On a measured page every box carries its character edges, using the width table for any item that could not be measured.
  const measured = located.some((entry) => entry.item.charEnds)
  for (const entry of located) {
    if (entry.start >= end || entry.end <= start) continue
    const length = entry.end - entry.start
    if (length <= 0) continue
    const coverStart = Math.max(entry.start, start)
    const coverEnd = Math.min(entry.end, end)
    if (coverEnd <= coverStart) continue
    const { str, x, y, w, h, charEnds } = entry.item
    const from = coverStart - entry.start
    const to = coverEnd - entry.start
    const span = spanWithinItem(str, x, w, from, to, charEnds)
    const box: SentenceBox = { x: span.x, y, w: span.w, h }
    if (measured) {
      box.start = coverStart - start
      box.charEnds = []
      for (let i = from; i < to; i += 1) {
        box.charEnds.push(roundPoints(spanWithinItem(str, x, w, from, i + 1, charEnds).w))
      }
    }
    boxes.push(box)
  }
  return mergeBoxes(boxes)
}

/** Sentences as the page needs them to draw: the boxes alone, without the character edges used on the server. */
export function sentencesForDrawing(sentences: readonly Sentence[]): Sentence[] {
  return sentences.map((sentence) => ({
    ...sentence,
    boxes: sentence.boxes.map(({ x, y, w, h }) => ({ x, y, w, h })),
  }))
}

export function buildSentenceDocument(document: ReadableDocument): SentenceDocument {
  const sentences: Sentence[] = []
  let counter = 0
  for (const page of document.pages) {
    const located = locateItems(page)
    for (const span of segmentPageText(page.text)) {
      counter += 1
      sentences.push({
        id: `s${counter}`,
        page: page.page,
        start: span.start,
        end: span.end,
        text: page.text.slice(span.start, span.end),
        boxes: boxesForSpan(located, span.start, span.end),
      })
    }
  }
  return { fingerprint: document.fingerprint, sentences }
}

function originalPath(fingerprint: string): string {
  return path.join(process.cwd(), 'data', 'originals', fingerprint)
}

function linkPath(fingerprint: string): string {
  return path.join(process.cwd(), 'data', 'links', `${fingerprint}.json`)
}

function readablePath(fingerprint: string): string {
  return path.join(process.cwd(), 'data', 'readable', `${fingerprint}.json`)
}

function sentencesPath(fingerprint: string): string {
  return path.join(process.cwd(), 'data', 'sentences', `${fingerprint}.json`)
}

function assertFingerprint(fingerprint: string): void {
  if (!/^[0-9a-f]{64}$/i.test(fingerprint)) {
    throw new SentenceDocumentNotFoundError()
  }
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function readCached(fingerprint: string): Promise<SentenceDocument | null> {
  let raw: string
  try {
    raw = await readFile(sentencesPath(fingerprint), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    const parsed = JSON.parse(raw) as SentenceDocument
    if (parsed && parsed.fingerprint === fingerprint && Array.isArray(parsed.sentences)) {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

export async function makeSentences(fingerprint: string): Promise<SentenceDocument> {
  assertFingerprint(fingerprint)

  const cached = await readCached(fingerprint)
  if (cached) return cached

  let rawReadable: string
  try {
    rawReadable = await readFile(readablePath(fingerprint), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const known =
      (await fileExists(originalPath(fingerprint))) || (await fileExists(linkPath(fingerprint)))
    if (!known) throw new SentenceDocumentNotFoundError()
    throw new ReadableNotBuiltError()
  }

  const readable = JSON.parse(rawReadable) as ReadableDocument
  const document = buildSentenceDocument(readable)

  const target = sentencesPath(fingerprint)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, JSON.stringify(document), 'utf8')
  return document
}
