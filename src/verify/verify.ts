import { createHash } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Plan, PlanPoint, PlanQuote, Sentence, SentenceState } from '@/lib/types'
import { SentenceDocumentNotFoundError, glyphWidth, spanWithinItem } from '@/sentences/sentences'

export type StartingState = Extract<SentenceState, 'explained' | 'skippable' | 'uncovered'>

export interface VerifiedCoverage {
  total: number
  explained: number
  skippable: number
  uncovered: number
  uncoveredIds: string[]
}

export interface VerificationReport {
  pageNotesKept: number
  pageNotesDropped: number
  quotesChecked: number
  quotesReanchored: number
  /** Quotes no sentence proves, plus repeats of a sentence the same point already cites. */
  quotesDropped: number
  droppedPointIds: string[]
  coverage: VerifiedCoverage
  states: Record<string, StartingState>
}

export interface VerifiedPlan {
  plan: Plan
  report: VerificationReport
}

export class OriginalTamperedError extends Error {
  constructor() {
    super(
      'The stored original of this text no longer matches its fingerprint, so it has changed since it was added. Nothing was read from it. Restore the original file to continue.',
    )
    this.name = 'OriginalTamperedError'
  }
}

interface SentenceIndex {
  textOf: Map<string, string>
  positionOf: Map<string, number>
  idsByText: Map<string, string[]>
}

function indexSentences(sentences: readonly Sentence[]): SentenceIndex {
  const idsByText = new Map<string, string[]>()
  for (const sentence of sentences) {
    idsByText.set(sentence.text, [...(idsByText.get(sentence.text) ?? []), sentence.id])
  }
  return {
    textOf: new Map(sentences.map((sentence) => [sentence.id, sentence.text])),
    positionOf: new Map(sentences.map((sentence, index) => [sentence.id, index])),
    idsByText,
  }
}

// The same text can appear twice, as with a repeated heading. The closest copy is the one meant.
function nearestTo(cited: string, ids: readonly string[], positionOf: Map<string, number>): string {
  const target = positionOf.get(cited) ?? 0
  const distance = (id: string) => Math.abs((positionOf.get(id) as number) - target)
  return ids.reduce((best, id) => (distance(id) < distance(best) ? id : best))
}

interface ProvenQuotes {
  quotes: PlanQuote[]
  reanchored: number
  dropped: number
}

function proveQuotes(point: PlanPoint, index: SentenceIndex): ProvenQuotes {
  const matches = (entry: PlanQuote) => index.textOf.get(entry.sentenceId) === entry.quote
  // A sentence a quote already matches stays with that quote, whatever order the quotes come in.
  const matched = new Set(point.quotes.filter(matches).map((entry) => entry.sentenceId))
  const cited = new Set<string>()
  const quotes: PlanQuote[] = []
  let reanchored = 0
  let dropped = 0

  for (const entry of point.quotes) {
    if (matches(entry)) {
      if (cited.has(entry.sentenceId)) {
        dropped += 1
        continue
      }
      cited.add(entry.sentenceId)
      quotes.push(entry)
      continue
    }
    const free = (index.idsByText.get(entry.quote) ?? []).filter(
      (id) => !matched.has(id) && !cited.has(id),
    )
    if (free.length === 0) {
      dropped += 1
      continue
    }
    const sentenceId = nearestTo(entry.sentenceId, free, index.positionOf)
    cited.add(sentenceId)
    quotes.push({ sentenceId, quote: entry.quote })
    reanchored += 1
  }
  return { quotes, reanchored, dropped }
}

/**
 * Checks every quote in a plan against the numbered sentences, character for character. A quote
 * filed under the wrong id moves to the sentence that says it. A quote no sentence says is
 * removed, and a point left with none goes with it, whatever its source kind: outside background
 * must still name the sentences that need it, so a point with nothing proven has nothing to light.
 */
function noteBoxes(sentence: Sentence, start: number, end: number) {
  if (!sentence.boxes.length || !sentence.text.length) return []
  if (sentence.boxes.every((b) => b.charEnds && b.start !== undefined)) {
    return sentence.boxes.flatMap((b) => {
      const first = b.start as number
      const edges = b.charEnds as number[]
      const lo = Math.max(start, first)
      const hi = Math.min(end, first + edges.length)
      if (hi <= lo) return []
      const segment = sentence.text.slice(first, first + edges.length)
      const span = spanWithinItem(segment, b.x, b.w, lo - first, hi - first, edges)
      return [{ x: span.x, y: b.y, w: span.w, h: b.h }]
    })
  }
  const totalW = sentence.boxes.reduce((a, b) => a + Math.abs(b.w), 0)
  if (!totalW) return []
  // Split the sentence text among its boxes (one box per line, in order) by
  // glyph width, so each box gets the substring it actually paints. Then the
  // shared glyph span locates the anchor inside that substring.
  const cumulative: number[] = [0]
  for (let i = 0; i < sentence.text.length; i += 1) cumulative.push(cumulative[i] + glyphWidth(sentence.text[i]))
  const totalGlyph = cumulative[cumulative.length - 1]
  if (totalGlyph <= 0) return []
  const out: { x: number; y: number; w: number; h: number }[] = []
  let acc = 0
  let charStart = 0
  sentence.boxes.forEach((b, boxIndex) => {
    acc += Math.abs(b.w)
    let charEnd = sentence.text.length
    if (boxIndex < sentence.boxes.length - 1) {
      const target = (totalGlyph * acc) / totalW
      charEnd = charStart
      while (charEnd < sentence.text.length && cumulative[charEnd + 1] < target) charEnd += 1
      if (charEnd < sentence.text.length && cumulative[charEnd + 1] === target) charEnd += 1
    }
    const lo = Math.max(start, charStart)
    const hi = Math.min(end, charEnd)
    if (hi > lo) {
      const segment = sentence.text.slice(charStart, charEnd)
      const span = spanWithinItem(segment, b.x, b.w, lo - charStart, hi - charStart)
      out.push({ x: span.x, y: b.y, w: span.w, h: b.h })
    }
    charStart = charEnd
  })
  return out
}
export function verifyPageNotes(plan: Plan, sentences: readonly Sentence[]) {
  const byId=new Map(sentences.map(s=>[s.id,s])); const kept: Plan['pageNotes']=[]; let dropped=0
  for (const n of plan.pageNotes??[]) { const s=byId.get(n.sentenceId); if(!s){dropped++;continue} const start=s.text.indexOf(n.anchor); if(start===-1){dropped++;continue} kept.push({...n, start, end:start+n.anchor.length, boxes: noteBoxes(s,start,start+n.anchor.length)}) }
  return { kept, dropped }
}
export function verifyPlan(plan: Plan, sentences: readonly Sentence[]): VerifiedPlan {
  const verified = structuredClone(plan)
  const pn = verifyPageNotes(verified, sentences); verified.pageNotes=pn.kept; verified.droppedPageNotes=(verified.droppedPageNotes??0)+pn.dropped
  const index = indexSentences(sentences)
  const explained = new Set<string>()
  const droppedPointIds: string[] = []
  let quotesChecked = 0
  let quotesReanchored = 0
  let quotesDropped = 0

  for (const step of verified.steps) {
    step.points = step.points.filter((point) => {
      const { quotes, reanchored, dropped } = proveQuotes(point, index)
      quotesChecked += point.quotes.length
      quotesReanchored += reanchored
      quotesDropped += dropped
      point.quotes = quotes
      point.sentenceIds = quotes.map((entry) => entry.sentenceId)
      if (quotes.length === 0) {
        droppedPointIds.push(point.id)
        return false
      }
      for (const id of point.sentenceIds) explained.add(id)
      return true
    })
  }

  const markedSkippable = new Set(verified.skippable.map((entry) => entry.sentenceId))
  const states: Record<string, StartingState> = {}
  const uncoveredIds: string[] = []
  let skippable = 0
  for (const { id } of sentences) {
    if (explained.has(id)) {
      states[id] = 'explained'
    } else if (markedSkippable.has(id)) {
      states[id] = 'skippable'
      skippable += 1
    } else {
      states[id] = 'uncovered'
      uncoveredIds.push(id)
    }
  }

  verified.skippable = verified.skippable.filter((entry) => states[entry.sentenceId] === 'skippable')
  verified.coverage = {
    total: sentences.length,
    covered: explained.size,
    skippable,
    uncovered: uncoveredIds,
  }
  verified.droppedQuotes += quotesDropped

  return {
    plan: verified,
    report: { pageNotesKept: pn.kept.length, pageNotesDropped: pn.dropped,
      quotesChecked,
      quotesReanchored,
      quotesDropped,
      droppedPointIds,
      coverage: {
        total: sentences.length,
        explained: explained.size,
        skippable,
        uncovered: uncoveredIds.length,
        uncoveredIds,
      },
      states,
    },
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

/**
 * Re-hashes the stored original against the fingerprint it was stored under. Links keep no
 * original, so there is nothing of theirs to hash.
 */
export async function verifyOriginal(fingerprint: string): Promise<void> {
  const notFound = () => new SentenceDocumentNotFoundError('This text could not be found.')
  if (!/^[0-9a-f]{64}$/i.test(fingerprint)) throw notFound()

  const data = path.join(process.cwd(), 'data')
  let bytes: Buffer
  try {
    bytes = await readFile(path.join(data, 'originals', fingerprint))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    if (await fileExists(path.join(data, 'links', `${fingerprint}.json`))) return
    throw notFound()
  }

  const hash = createHash('sha256').update(bytes).digest('hex')
  if (hash !== fingerprint.toLowerCase()) throw new OriginalTamperedError()
}
