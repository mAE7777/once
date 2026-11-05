import type { PlanSkippable, ReadablePage, Sentence } from '@/lib/types'
import { viewStoredPlan } from '@/deepread/deepread'
import { makeSentences } from '@/sentences/sentences'
import { orderItemsForReading } from './ordering'
import { makeReadable } from './readable'

export type StandardBlockType = 'heading' | 'paragraph' | 'caption' | 'folio'

/** A stretch of display text. `id` is the sentence it belongs to; a run without one is the space between sentences. */
export interface StandardRun { id?: string; text: string }

export interface StandardBlock {
  type: StandardBlockType
  level: number
  centered?: boolean
  sentenceIds: string[]
  text: string
  runs: StandardRun[]
}

export interface StandardLayout {
  fingerprint: string
  hasOriginal: boolean
  blocks: StandardBlock[]
  sentences: { id: string; start: number; end: number; text: string; page: number }[]
}

export interface BuildStandardOptions {
  pages?: readonly ReadablePage[]
  skippable?: readonly PlanSkippable[]
}

const SUFFIX = /^(?:ing|ings|ed|er|ers|es|est|ly|tion|tions|sion|sions|ment|ments|ness|able|ible|ity|ities|al|ally|ous|ive|ize|ized|ise|ised|ism|ist|ists|ful|less|ance|ence)$/
const NUMBERED_HEADING = /^(\d+(?:\.\d+){0,3})\.?\s+\p{Lu}/u
const CAPTION = /^(?:Figure|Fig\.|Table)\s+\d+[.:]/
const TABLE_CAPTION = /^Table\s+\d+[.:]/
const REFERENCE = /^\[\d+\]\s+\p{Lu}/u
const FOOTNOTE = /^(?:\d{1,2}\s?|[∗*†‡§]\s?)\p{Lu}/u
const FIGURE_CAPTION = /^(?:Figure|Fig\.)\s+\d+[.:]/
const PAGE_NUMBER = /^\s*\d{1,4}\s*$/
const LEFT_OUT_REASON = /page number|stray|word list|labels?\b|(?:inside|within|from)\s+(?:a |an |the )?(?:figure|image|diagram|table)|figure[- ]internal/i

export interface HyphenContext { compounds: ReadonlySet<string>; words: ReadonlySet<string> }

/** Learns from the text itself which hyphenated forms are real, ignoring words broken across a line. */
export function hyphenContext(texts: readonly string[]): HyphenContext {
  const compounds = new Set<string>()
  const words = new Set<string>()
  for (const raw of texts) {
    const text = raw.replace(/\p{L}+-\s*\n\s*\p{L}+/gu, ' ').toLowerCase()
    for (const match of text.matchAll(/\p{L}+(?:-\p{L}+)+/gu)) {
      const parts = match[0].split('-')
      for (let i = 0; i + 1 < parts.length; i += 1) compounds.add(`${parts[i]}-${parts[i + 1]}`)
    }
    for (const match of text.matchAll(/(?<![\p{L}-])\p{L}+(?![\p{L}-])/gu)) words.add(match[0])
  }
  return { compounds, words }
}

/**
 * What to show where one line ends in a hyphen and the next line carries on.
 * 'join' removes the hyphen, 'keep' leaves it, and neither adds a space.
 */
export function lineEndHyphen(left: string, right: string, context: HyphenContext): 'join' | 'keep' {
  const tail = /(\p{L}+(?:-\p{L}+)*)-$/u.exec(left.trimEnd())
  const head = /^\p{L}+/u.exec(right.trimStart())
  if (!tail || !head) return 'keep'
  const token = tail[1]
  const lastPart = token.slice(token.lastIndexOf('-') + 1)
  if (token.includes('-')) return 'keep'
  if (!/\p{Ll}$/u.test(lastPart) || !/^\p{Ll}/u.test(head[0])) return 'keep'
  const first = lastPart.toLowerCase()
  const second = head[0].toLowerCase()
  if (context.compounds.has(`${first}-${second}`)) return 'keep'
  const standsAlone = first.length >= 4 && context.words.has(first)
  if (standsAlone && !context.words.has(first + second) && !SUFFIX.test(second)) return 'keep'
  return 'join'
}

/** The sentence's words as they read on the sheet. The stored text is left as it is. */
export function displayText(source: string, context: HyphenContext): string {
  const lines = source.split('\n')
  let out = lines[0] ?? ''
  for (let i = 1; i < lines.length; i += 1) out = joinLines(out, lines[i], context)
  return out.replace(/\s+/g, ' ').trim()
}

function joinLines(left: string, right: string, context: HyphenContext): string {
  const trimmed = left.trimEnd()
  const next = right.trimStart()
  if (!trimmed.endsWith('-') || !/^\p{L}/u.test(next) || !/\p{L}-$/u.test(trimmed)) return `${trimmed} ${next}`
  return lineEndHyphen(trimmed, next, context) === 'join' ? trimmed.slice(0, -1) + next : trimmed + next
}

interface Located { id: string; page: number; start: number; end: number }

function locateSentences(sentences: readonly Sentence[], textOf: (page: number) => string): Map<number, Located[]> {
  const byPage = new Map<number, Located[]>()
  const cursors = new Map<number, number>()
  for (const s of sentences) {
    const text = textOf(s.page)
    let start = text.slice(s.start, s.end) === s.text ? s.start : -1
    if (start < 0) start = text.indexOf(s.text, cursors.get(s.page) ?? 0)
    if (start < 0) continue
    cursors.set(s.page, start + s.text.length)
    byPage.set(s.page, [...(byPage.get(s.page) ?? []), { id: s.id, page: s.page, start, end: start + s.text.length }])
  }
  return byPage
}

interface Segment { page: number; start: number; end: number }

interface Draft { type: StandardBlockType; level: number; centered: boolean; segments: Segment[] }

interface Assembler {
  textOf: (page: number) => string
  located: Map<number, Located[]>
  leftOut: ReadonlySet<string>
  context: HyphenContext
}

function assemble(draft: Draft, a: Assembler): StandardBlock {
  const runs: StandardRun[] = []
  const push = (text: string, id?: string) => {
    if (!text) return
    const last = runs[runs.length - 1]
    if (last && last.id === id) last.text += text
    else runs.push(id ? { id, text } : { text })
  }
  let before = ''
  let previousId: string | undefined
  for (const segment of draft.segments) {
    const text = a.textOf(segment.page)
    const covering = (a.located.get(segment.page) ?? []).filter(
      (s) => s.start < segment.end && s.end > segment.start && !a.leftOut.has(s.id),
    )
    const parts: { id?: string; text: string }[] = []
    let cursor = segment.start
    for (const s of covering) {
      const from = Math.max(s.start, segment.start)
      const to = Math.min(s.end, segment.end)
      if (from > cursor) parts.push({ text: text.slice(cursor, from) })
      parts.push({ id: s.id, text: text.slice(from, to) })
      cursor = to
    }
    if (cursor < segment.end) parts.push({ text: text.slice(cursor, segment.end) })

    let isLineStart = true
    for (const part of parts) {
      const clean = part.text.replace(/\s+/g, ' ')
      if (!clean.trim() && (isLineStart || !part.text)) continue
      if (!clean.trim() && !part.id) { push(' '); continue }
      const body = isLineStart ? clean.trimStart() : clean
      if (isLineStart && before) {
        const hyphenated = /\p{L}-\s*$/u.test(before) && /^\p{L}/u.test(body)
        if (hyphenated) {
          if (lineEndHyphen(before, body, a.context) === 'join') {
            const last = runs[runs.length - 1]
            last.text = last.text.trimEnd().slice(0, -1)
          }
        } else if (!/\s$/.test(before)) {
          push(' ', part.id !== undefined && part.id === previousId ? part.id : undefined)
        }
      }
      push(body, part.id)
      before = (runs[runs.length - 1]?.text ?? '').slice(-64)
      previousId = part.id
      isLineStart = false
    }
  }
  const last = runs[runs.length - 1]
  if (last) last.text = last.text.trimEnd()
  while (runs.length && !runs[runs.length - 1].text) runs.pop()
  const sentenceIds = [...new Set(runs.flatMap((run) => (run.id ? [run.id] : [])))]
  return {
    type: draft.type,
    level: draft.level,
    ...(draft.centered ? { centered: true } : {}),
    sentenceIds,
    text: runs.map((run) => run.text).join(''),
    runs,
  }
}

interface Line extends Segment {
  text: string
  x: number
  right: number
  y: number
  h: number
  placed: boolean
  /** A table row or a label from inside a figure: it has no place on a sheet. */
  absent: boolean
  /** Items drawn over each other, which body text never does: rotated labels in a figure. */
  tangled: boolean
  folio: boolean
}

function mode(values: readonly number[], step: number, fallback: number): number {
  const counts = new Map<number, number>()
  for (const value of values) {
    const key = Math.round(value / step)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  let best: number | null = null
  let bestCount = 0
  for (const [key, count] of counts) {
    if (count > bestCount) { best = key; bestCount = count }
  }
  return best === null ? fallback : best * step
}

function isTangled(own: readonly { x: number; right: number }[]): boolean {
  const sorted = [...own].sort((a, b) => a.x - b.x)
  let overlaps = 0
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i - 1].right - sorted[i].x > 1.5) overlaps += 1
  }
  return overlaps >= 2
}

/** Page text lines with the position and size of the items that make them. */
function pageLines(page: ReadablePage): Line[] {
  const placed: { start: number; end: number; x: number; right: number; y: number; h: number; size: number }[] = []
  let offset = 0
  for (const item of orderItemsForReading(page.items, page.width)) {
    if (!item.str) continue
    const at = page.text.indexOf(item.str, offset)
    if (at < 0) continue
    offset = at + item.str.length
    if (item.str.trim()) placed.push({ start: at, end: offset, x: item.x, right: item.x + item.w, y: item.y, h: Math.abs(item.h), size: item.str.trim().length })
  }
  const lines: Line[] = []
  let start = 0
  for (const text of page.text.split('\n')) {
    const end = start + text.length
    const own = placed.filter((p) => p.start >= start && p.end <= end)
    const main = own.reduce<typeof own[number] | null>((best, p) => (!best || p.size > best.size ? p : best), null)
    lines.push({
      page: page.page,
      start,
      end,
      text,
      x: own.length ? Math.min(...own.map((p) => p.x)) : 0,
      right: own.length ? Math.max(...own.map((p) => p.right)) : 0,
      y: main?.y ?? 0,
      h: main?.h ?? 0,
      placed: own.length > 0,
      absent: false,
      tangled: isTangled(own),
      folio: false,
    })
    start = end + 1
  }
  return lines
}

function hasColumnGap(line: Line, page: ReadablePage, em: number): boolean {
  const own = page.items
    .filter((item) => item.str.trim() && Math.abs(item.y - line.y) <= Math.max(2, em * 0.5))
    .sort((a, b) => a.x - b.x)
  for (let i = 1; i < own.length; i += 1) {
    if (own[i].x - (own[i - 1].x + own[i - 1].w) > em * 1.5) return true
  }
  return false
}

function isNumericRow(text: string): boolean {
  const tokens = text.trim().split(/\s+/).filter(Boolean)
  const numeric = tokens.filter((t) => /^[(\[]?[\d.,·×%+-]+[)\]]?$/.test(t))
  return numeric.length >= 2 && numeric.length / tokens.length >= 0.5
}

/** Marks the rows of a table: what follows a table caption up to the next prose or heading, and any run of number rows. */
function markTables(lines: Line[], page: ReadablePage, bodyWidth: number, em: number): void {
  for (let i = 0; i < lines.length; i += 1) {
    if (!TABLE_CAPTION.test(lines[i].text.trim())) continue
    let at = i
    while (
      at + 1 < lines.length &&
      !/[.!?]\s*$/.test(lines[at].text) &&
      lines[at].right - lines[at].x >= bodyWidth * 0.7 &&
      Math.abs(lines[at].y - lines[at + 1].y) <= em * 1.6
    ) at += 1
    let row = at + 1
    while (row < lines.length) {
      const line = lines[row]
      const text = line.text.trim()
      if (NUMBERED_HEADING.test(text) && !isNumericRow(text)) break
      const wide = line.placed && line.right - line.x >= bodyWidth * 0.7
      if (wide && !hasColumnGap(line, page, em) && !isNumericRow(text)) break
      if (/[.!?:]\s*$/.test(text) && text.split(/\s+/).length >= 6) break
      line.absent = true
      row += 1
    }
  }
  let run: Line[] = []
  const flush = () => {
    if (run.length >= 3) for (const line of run) line.absent = true
    run = []
  }
  for (const line of lines) {
    if (isNumericRow(line.text)) run.push(line)
    else flush()
  }
  flush()
}

/** Marks labels from inside a figure: tangled lines anywhere, and the short lines stacked right above a figure caption. */
function markFigureLabels(lines: Line[], bodyWidth: number): void {
  const hasTangled = lines.some((line) => line.tangled)
  lines.forEach((line, index) => {
    if (line.tangled) line.absent = true
    if (!FIGURE_CAPTION.test(line.text.trim())) return
    for (let i = index - 1; i >= 0; i -= 1) {
      const above = lines[i]
      const text = above.text.trim()
      if (above.absent || !text) continue
      const words = text.split(/\s+/).length
      const short = hasTangled ? words <= 6 : above.placed && above.right - above.x < bodyWidth * 0.5 && words <= 4
      if (!short || endsSentence(text) || NUMBERED_HEADING.test(text) || PAGE_NUMBER.test(text)) break
      above.absent = true
    }
  })
}

function isCentered(line: Line, page: ReadablePage, bodyWidth: number): boolean {
  if (!line.placed || page.width <= 0) return false
  const width = line.right - line.x
  return width < bodyWidth * 0.7 && Math.abs((line.x + line.right) / 2 - page.width / 2) <= 6
}

function endsSentence(text: string): boolean {
  return /[.!?\u3002\uff01\uff1f:;]["'”’)\]]*\s*$/.test(text)
}

function startsLower(text: string): boolean {
  return /^(?:\[\d+\]\s+)?\p{Ll}/u.test(text.trimStart())
}

interface Metrics { em: number; leading: number; width: number }

function headingLevel(line: Line, next: Line | undefined, m: Metrics): number {
  const text = line.text.trim()
  if (!text || text.length > 100 || /[.,;:]$/.test(text)) return 0
  const wordCount = text.split(/\s+/).length
  if (wordCount > 14 || isNumericRow(text)) return 0
  const gapAfter = !next || !next.placed || !line.placed || next.page !== line.page || Math.abs(line.y - next.y) > m.leading * 1.25
  const numbered = NUMBERED_HEADING.exec(text)
  const short = !line.placed || line.right - line.x < m.width * 0.85
  if (numbered && gapAfter && short) return Math.min(numbered[1].split('.').length, 3)
  if (line.placed && line.h >= m.em * 1.15 && gapAfter && !startsLower(text) && line.right - line.x < m.width * 0.75) return line.h >= m.em * 1.5 ? 1 : 2
  return 0
}

function breaksParagraph(previous: Line, line: Line, page: ReadablePage, left: number, m: Metrics): boolean {
  if (REFERENCE.test(line.text.trim())) return true
  if (!previous.placed || !line.placed) return false
  const delta = previous.y - line.y
  if (delta < -m.em) return endsSentence(previous.text) || !startsLower(line.text)
  const bodySized = previous.h >= m.em * 0.85 && line.h >= m.em * 0.85
  if (bodySized && delta > m.leading * 1.35) return true
  if (isCentered(previous, page, m.width) && isCentered(line, page, m.width)) return true
  if (hasColumnGap(previous, page, m.em) && hasColumnGap(line, page, m.em)) return true
  const indent = line.x - left
  if (indent >= m.em * 0.8 && indent <= m.em * 5 && previous.x - left < m.em * 0.5 && !REFERENCE.test(previous.text.trim())) {
    return endsSentence(previous.text)
  }
  return false
}

function pageDrafts(lines: readonly Line[], page: ReadablePage, m: Metrics): Draft[] {
  const left = mode(lines.filter((l) => l.placed).map((l) => l.x), 1, 0)
  const drafts: Draft[] = []
  let current: Draft | null = null
  let previous: Line | null = null
  let inReference = false
  let footnoteOpen = false
  lines.forEach((line, index) => {
    const segment: Segment = { page: line.page, start: line.start, end: line.end }
    if (line.folio) {
      drafts.push({ type: 'folio', level: 0, centered: true, segments: [segment] })
      current = null
      previous = null
      return
    }
    const level = headingLevel(line, lines[index + 1], m)
    if (level > 0) {
      drafts.push({ type: 'heading', level, centered: isCentered(line, page, m.width), segments: [segment] })
      current = null
      previous = null
      return
    }
    const text = line.text.trim()
    const caption = CAPTION.test(text)
    const isReference = REFERENCE.test(text)
    const captionDone = current !== null && (current as Draft).type === 'caption' && previous !== null && (footnoteOpen ? line.h >= m.em * 0.95 : /[.!?]\s*$/.test((previous as Line).text))
    const footnoteGoesOn = footnoteOpen && current !== null && !caption && line.h > 0 && line.h < m.em * 0.95
    const paragraphEnds = previous !== null && !inReferenceContinuation(inReference, isReference, previous, line, m) && breaksParagraph(previous, line, page, left, m)
    const opensNew = current === null || caption || (!footnoteGoesOn && (captionDone || paragraphEnds))
    if (opensNew) {
      const footnote = FOOTNOTE.test(text) && line.h > 0 && line.h < m.em * 0.95
      footnoteOpen = footnote
      current = {
        type: caption || footnote ? 'caption' : 'paragraph',
        level: 0,
        centered: !caption && !footnote && (isCentered(line, page, m.width) || hasColumnGap(line, page, m.em)),
        segments: [segment],
      }
      drafts.push(current)
      inReference = isReference
    } else {
      (current as Draft).segments.push(segment)
      if (isReference) inReference = true
    }
    previous = line
  })
  return drafts
}

/** A wrapped reference is indented under its number, so the indent does not open a new paragraph. */
function inReferenceContinuation(inReference: boolean, isReference: boolean, previous: Line, line: Line, m: Metrics): boolean {
  if (!inReference || isReference || !previous.placed || !line.placed) return false
  return Math.abs(previous.y - line.y) <= m.leading * 1.35
}

function metricsOf(lines: readonly Line[]): Metrics {
  const placed = lines.filter((l) => l.placed)
  const weightedHeights = placed.flatMap((l) => Array.from({ length: Math.min(l.text.length, 200) }, () => l.h))
  const em = mode(weightedHeights, 0.1, 10) || 10
  const deltas: number[] = []
  for (let i = 1; i < placed.length; i += 1) {
    if (placed[i].page !== placed[i - 1].page) continue
    const delta = placed[i - 1].y - placed[i].y
    if (delta > 0 && Math.abs(placed[i].h - em) < em * 0.1 && Math.abs(placed[i - 1].h - em) < em * 0.1) deltas.push(delta)
  }
  const leading = mode(deltas, 0.25, em * 1.2) || em * 1.2
  const widths = placed.filter((l) => l.text.length > 40).map((l) => l.right - l.x)
  const width = mode(widths, 2, 0) || Math.max(0, ...placed.map((l) => l.right - l.x))
  return { em, leading, width }
}

function draftsFromOcr(page: ReadablePage): Draft[] {
  const blocks = page.blocks ?? []
  const sizes = blocks.map((b) => b.h / Math.max(1, b.lines ?? 1))
  const typical = mode(sizes, 1, 0)
  const drafts: Draft[] = []
  let cursor = 0
  for (const block of blocks) {
    const at = page.text.indexOf(block.text, cursor)
    if (at < 0) continue
    cursor = at + block.text.length
    const text = block.text.trim()
    if (!text) continue
    const size = block.h / Math.max(1, block.lines ?? 1)
    const numbered = NUMBERED_HEADING.exec(text)
    const short = text.length <= 100 && !/[.,;:]$/.test(text) && !text.includes('\n')
    const large = typical > 0 && size >= typical * 1.2
    const level = short && numbered ? Math.min(numbered[1].split('.').length, 3) : short && large ? 2 : 0
    const segments: Segment[] = []
    let start = at
    for (const line of block.text.split('\n')) {
      segments.push({ page: page.page, start, end: start + line.length })
      start += line.length + 1
    }
    drafts.push({ type: level > 0 ? 'heading' : CAPTION.test(text) ? 'caption' : 'paragraph', level, centered: false, segments })
  }
  return drafts
}

function draftsFromPages(
  pages: readonly ReadablePage[],
  located: Map<number, Located[]>,
  leftOut: Set<string>,
  skippable: ReadonlySet<string>,
): Draft[] {
  const perPage = pages.map((page) => (page.blocks?.length ? [] : pageLines(page)))
  const metrics = metricsOf(perPage.flat())
  const out: Draft[] = []
  pages.forEach((page, index) => {
    const sentencesHere = located.get(page.page) ?? []
    const coveringOf = (line: Line) => sentencesHere.filter((s) => s.start < line.end && s.end > line.start)
    let drafts: Draft[]
    if (page.blocks?.length) {
      drafts = draftsFromOcr(page)
    } else {
      const all = perPage[index]
      markTables(all, page, metrics.width, metrics.em)
      markFigureLabels(all, metrics.width)
      const last = [...all].reverse().find((l) => l.text.trim())
      const kept = all.filter((line) => {
        if (!line.text.trim() || line.absent) return false
        const covering = coveringOf(line)
        if (covering.length > 0 && covering.every((s) => leftOut.has(s.id))) return false
        if (line === last && PAGE_NUMBER.test(line.text)) {
          // A page number fused onto a sentence stays unless the plan already lets that sentence be skipped.
          if (covering.length > 0 && covering.every((s) => skippable.has(s.id))) return false
          line.folio = true
        }
        return true
      })
      drafts = pageDrafts(kept, page, metrics)
    }
    let headingSeen = false
    for (const draft of drafts) {
      const firstText = page.text.slice(draft.segments[0].start, draft.segments[0].end)
      if (draft.type === 'heading') headingSeen = true
      if (draft.type === 'paragraph' && !headingSeen && startsLower(firstText)) {
        let tail: Draft | null = null
        for (let i = out.length - 1; i >= 0; i -= 1) {
          const candidate = out[i]
          if (candidate.type === 'heading') break
          if (candidate.type === 'paragraph') { tail = candidate; break }
        }
        if (tail) {
          const lastSegment = tail.segments[tail.segments.length - 1]
          const lastPage = pages.find((p) => p.page === lastSegment.page)
          const lastText = lastPage ? lastPage.text.slice(lastSegment.start, lastSegment.end) : ''
          if (lastSegment.page !== page.page && !endsSentence(lastText)) {
            tail.segments.push(...draft.segments)
            headingSeen = true
            continue
          }
        }
      }
      if (draft.type === 'paragraph') headingSeen = true
      out.push(draft)
    }
  })
  return out
}

function draftsFromText(text: string, page: number): Draft[] {
  const drafts: Draft[] = []
  const pattern = /(?:[^\n]|\n(?!\s*\n))+/g
  for (const match of text.matchAll(pattern)) {
    const chunk = match[0]
    if (!chunk.trim()) continue
    const lines = chunk.split('\n')
    const heading = /^\s*(#{1,6})\s+\S/.exec(lines[0])
    const isHeading = heading !== null && lines.filter((l) => l.trim()).length === 1
    const segments: Segment[] = []
    let start = match.index
    for (const line of lines) {
      const marker = /^\s*#{1,6}\s+/.exec(line)
      segments.push({ page, start: start + (marker ? marker[0].length : 0), end: start + line.length })
      start += line.length + 1
    }
    drafts.push({ type: isHeading ? 'heading' : 'paragraph', level: isHeading ? heading![1].length : 0, centered: false, segments })
  }
  return drafts
}

/**
 * Lays out the document as display blocks. Stored sentences are only read: ids, spans and text stay as they are.
 * Left out are table rows, labels from inside a figure, and sentences the plan marks as a page number or as such labels.
 */
export function buildStandard(
  fullText: string,
  sentences: readonly Sentence[],
  _kind: string,
  options: BuildStandardOptions = {},
): StandardBlock[] {
  const pages = options.pages?.filter((page) => page.items.length > 0 || page.blocks?.length)
  const usePages = Boolean(pages?.length && pages.length === options.pages?.length)
  const textByPage = new Map((options.pages ?? []).map((page) => [page.page, page.text]))
  const textOf = (page: number) => (usePages ? textByPage.get(page) ?? '' : fullText)
  const located = locateSentences(sentences, textOf)
  const skippable = new Set((options.skippable ?? []).map((s) => s.sentenceId))
  const leftOut = new Set(
    (options.skippable ?? []).filter((s) => LEFT_OUT_REASON.test(s.reason) && !CAPTION.test(sentences.find((x) => x.id === s.sentenceId)?.text ?? '')).map((s) => s.sentenceId),
  )
  const context = hyphenContext(usePages ? (options.pages ?? []).map((p) => p.text) : [fullText])
  const a: Assembler = { textOf, located, leftOut, context }
  const drafts = usePages
    ? draftsFromPages(pages ?? [], located, leftOut, skippable)
    : draftsFromText(fullText, sentences[0]?.page ?? 1)
  const blocks = drafts.map((draft) => assemble(draft, a)).filter((block) => block.runs.length > 0)

  if (!usePages) {
    // Sentences not found in the text still reach the reader.
    const placed = new Set(blocks.flatMap((b) => b.sentenceIds))
    const missing = sentences.filter((s) => !placed.has(s.id) && !leftOut.has(s.id))
    if (missing.length) {
      const runs = missing.flatMap((s, i) => [...(i ? [{ text: ' ' }] : []), { id: s.id, text: displayText(s.text, context) }])
      blocks.push({ type: 'paragraph', level: 0, sentenceIds: missing.map((s) => s.id), text: runs.map((r) => r.text).join(''), runs })
    }
  }
  return blocks
}

export async function makeStandard(fingerprint: string): Promise<StandardLayout> {
  const doc = await makeReadable(fingerprint)
  const { sentences } = await makeSentences(fingerprint)
  const hasOriginal = doc.kind === 'pdf' || doc.kind === 'image'
  let skippable: PlanSkippable[] = []
  try {
    skippable = (await viewStoredPlan(fingerprint)).stored?.plan.skippable ?? []
  } catch {
    skippable = []
  }
  return {
    fingerprint,
    hasOriginal,
    blocks: buildStandard(doc.fullText, sentences, doc.kind, { pages: doc.pages, skippable }),
    sentences: sentences.map((s) => ({ id: s.id, start: s.start, end: s.end, text: s.text, page: s.page })),
  }
}
