import type { PageNote, Plan, PlanLink, PlanPoint, PlanQuestion, PlanSource, PlanStep, PlanStickingPoint, PlanUsage, PlanVolume, Sentence } from '@/lib/types'
import {
  PLAN_STEP_KINDS,
  type RawPlan,
  type RawPoint,
  type RawRepair,
  type RawSkipRange,
  type RawSource,
} from './schema'

export interface Citation {
  url: string
  title: string | null
}

function isWebUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value)
}

function addCitation(found: Map<string, Citation>, rawUrl: unknown, title: unknown): void {
  // Search results have been seen with trailing spaces on the address.
  const url = typeof rawUrl === 'string' ? rawUrl.trim() : rawUrl
  if (!isWebUrl(url) || found.has(url)) return
  found.set(url, { url, title: typeof title === 'string' && title.trim() ? title : null })
}

/** Every address the API itself reports as retrieved or cited in this response. */
export function collectCitations(response: Record<string, unknown>): Citation[] {
  const found = new Map<string, Citation>()
  const output = Array.isArray(response.output) ? response.output : []
  for (const item of output as Record<string, unknown>[]) {
    if (item?.type === 'web_search_call') {
      const results = Array.isArray(item.results) ? item.results : []
      for (const result of results as Record<string, unknown>[]) {
        addCitation(found, result?.url, result?.title)
      }
    }
    if (item?.type === 'message') {
      const content = Array.isArray(item.content) ? item.content : []
      for (const part of content as Record<string, unknown>[]) {
        const annotations = Array.isArray(part?.annotations) ? part.annotations : []
        for (const annotation of annotations as Record<string, unknown>[]) {
          if (annotation?.type === 'url_citation') {
            addCitation(found, annotation.url, annotation.title)
          }
        }
      }
    }
  }
  return [...found.values()]
}

// The model tends to tidy addresses (dropping tracking parameters, say). Matching loosely is
// safe because what gets stored is always the retrieved address, never the model's spelling.
function urlKeys(raw: string): { full: string; bare: string } | null {
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    return null
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '')
  const pathname = parsed.pathname.replace(/\/+$/, '')
  return { full: `${host}${pathname}${parsed.search}`, bare: `${host}${pathname}` }
}

export class SourceResolver {
  private readonly exact = new Map<string, Citation>()
  private readonly bare = new Map<string, Citation>()
  private readonly used = new Map<string, PlanLink>()
  private externalKept = 0
  private downgraded = 0

  constructor(citations: readonly Citation[]) {
    for (const citation of citations) {
      const keys = urlKeys(citation.url)
      if (!keys) continue
      if (!this.exact.has(keys.full)) this.exact.set(keys.full, citation)
      if (!this.bare.has(keys.bare)) this.bare.set(keys.bare, citation)
    }
  }

  resolve(source: RawSource): PlanSource {
    if (source.kind !== 'external') return { kind: source.kind, url: null, title: null }
    const keys = urlKeys(source.url)
    const citation = keys ? (this.exact.get(keys.full) ?? this.bare.get(keys.bare)) : undefined
    if (!citation) {
      this.downgraded += 1
      return { kind: 'inference', url: null, title: null }
    }
    this.externalKept += 1
    const title = citation.title ?? (source.title.trim() || null)
    this.used.set(citation.url, { url: citation.url, title })
    return { kind: 'external', url: citation.url, title }
  }

  summary(): Plan['sourcing'] {
    return {
      externalKept: this.externalKept,
      downgradedToInference: this.downgraded,
      links: [...this.used.values()],
    }
  }
}

interface CitationHolder {
  location: string
  ids: string[]
  replace: (wrong: string, right: string, quote: string) => void
}

function listHolder(
  location: string,
  owner: Record<string, unknown>,
  field: string,
): CitationHolder {
  const current = () => owner[field] as string[]
  return {
    location,
    ids: [...current()],
    replace(wrong, right) {
      owner[field] = right
        ? current().map((id) => (id === wrong ? right : id))
        : current().filter((id) => id !== wrong)
    },
  }
}

// Locations are stable names for the repair prompt: pt3 is the third point in reading order.
function citationHolders(raw: RawPlan): CitationHolder[] {
  const holders: CitationHolder[] = []
  let pointNumber = 0
  for (const step of raw.steps) {
    for (const point of step.points) {
      pointNumber += 1
      holders.push({
        location: `pt${pointNumber}`,
        ids: point.quotes.map((quote) => quote.sentenceId),
        replace(wrong, right, corrected) {
          point.quotes = right
            ? point.quotes.map((quote) =>
                quote.sentenceId === wrong
                  ? { sentenceId: right, quote: corrected || quote.quote }
                  : quote,
              )
            : point.quotes.filter((quote) => quote.sentenceId !== wrong)
        },
      })
    }
  }
  raw.questions.forEach((q,i)=>{ holders.push(listHolder(`q${i+1}`, q as never, 'earnsSentenceIds')) })
  raw.pageNotes.forEach((n,i)=>{ holders.push({location:`note${i+1}`, ids:[n.sentenceId], replace(w,r){ if(n.sentenceId===w) n.sentenceId=r }}) })
  raw.skippable.forEach((range, index) => {
    holders.push({
      location: `skip${index + 1}`,
      ids: [range.fromSentenceId, range.toSentenceId],
      replace(wrong, right) {
        if (range.fromSentenceId === wrong) range.fromSentenceId = right
        if (range.toSentenceId === wrong) range.toSentenceId = right
      },
    })
  })
  return holders
}

export interface PlanAudit {
  uncovered: string[]
  /** Sentence ids cited by boundaries, terms, questions or skippable ranges that do not exist. */
  unknownCitations: { location: string; id: string }[]
  /** Quotes in points whose text is not the text of the sentence they cite. */
  unprovenQuotes: { location: string; id: string; quote: string }[]
  unsourcedPoints: string[]
}

export function auditIsClean(audit: PlanAudit): boolean {
  return (
    audit.uncovered.length === 0 &&
    audit.unknownCitations.length === 0 &&
    audit.unprovenQuotes.length === 0 &&
    audit.unsourcedPoints.length === 0
  )
}

function eachPoint(raw: RawPlan): RawPoint[] {
  return raw.steps.flatMap((step) => step.points)
}

/**
 * Settles what can be settled without the model. Seen in real responses: line breaks escaped
 * twice, so a literal backslash-n sits in the quote, and a run of quotes filed under the id of
 * the sentence before. Only a character-for-character match moves a quote, so nothing is proven
 * that the text does not say.
 */
export function settleQuotes(raw: RawPlan, sentences: readonly Sentence[]): RawPlan {
  const settled = structuredClone(raw)
  const positions = positionsOf(sentences)
  const textOf = new Map(sentences.map((sentence) => [sentence.id, sentence.text]))
  const idsByText = new Map<string, string[]>()
  for (const sentence of sentences) {
    idsByText.set(sentence.text, [...(idsByText.get(sentence.text) ?? []), sentence.id])
  }

  const nearest = (ids: readonly string[], to: string): string => {
    const target = positions.get(to) ?? 0
    return ids.reduce((best, id) =>
      Math.abs((positions.get(id) as number) - target) < Math.abs((positions.get(best) as number) - target)
        ? id
        : best,
    )
  }

  for (const point of eachPoint(settled)) {
    point.quotes = point.quotes.map((entry) => {
      if (textOf.get(entry.sentenceId) === entry.quote) return entry
      const unescaped = entry.quote.replaceAll('\\n', '\n')
      for (const candidate of [entry.quote, unescaped]) {
        if (textOf.get(entry.sentenceId) === candidate) return { ...entry, quote: candidate }
        const ids = idsByText.get(candidate)
        if (ids) return { sentenceId: nearest(ids, entry.sentenceId), quote: candidate }
      }
      return entry
    })
    const seen = new Set<string>()
    point.quotes = point.quotes.filter((entry) => {
      if (seen.has(entry.sentenceId)) return false
      seen.add(entry.sentenceId)
      return true
    })
  }
  return settled
}

/** Removes quotes that still do not match. They would prove nothing, so they cover nothing. */
export function dropUnprovenQuotes(
  raw: RawPlan,
  sentences: readonly Sentence[],
): { raw: RawPlan; dropped: number } {
  const kept = structuredClone(raw)
  const textOf = new Map(sentences.map((sentence) => [sentence.id, sentence.text]))
  let dropped = 0
  for (const point of eachPoint(kept)) {
    const before = point.quotes.length
    point.quotes = point.quotes.filter((entry) => textOf.get(entry.sentenceId) === entry.quote)
    dropped += before - point.quotes.length
  }
  return { raw: kept, dropped }
}

function expandRange(range: RawSkipRange, positions: Map<string, number>, sentences: readonly Sentence[]): string[] {
  const from = positions.get(range.fromSentenceId)
  const to = positions.get(range.toSentenceId)
  if (from === undefined || to === undefined) return []
  const first = Math.min(from, to)
  const last = Math.max(from, to)
  return sentences.slice(first, last + 1).map((sentence) => sentence.id)
}

function positionsOf(sentences: readonly Sentence[]): Map<string, number> {
  return new Map(sentences.map((sentence, index) => [sentence.id, index]))
}

export function auditPlan(raw: RawPlan, sentences: readonly Sentence[]): PlanAudit {
  const positions = positionsOf(sentences)
  const textOf = new Map(sentences.map((sentence) => [sentence.id, sentence.text]))
  const accounted = new Set<string>()
  const unknownCitations: PlanAudit['unknownCitations'] = []
  const unprovenQuotes: PlanAudit['unprovenQuotes'] = []
  const unsourcedPoints: string[] = []

  eachPoint(raw).forEach((point, index) => {
    const location = `pt${index + 1}`
    if (point.quotes.length === 0) unsourcedPoints.push(location)
    for (const entry of point.quotes) {
      if (textOf.get(entry.sentenceId) === entry.quote) accounted.add(entry.sentenceId)
      else unprovenQuotes.push({ location, id: entry.sentenceId, quote: entry.quote })
    }
  })
  for (const holder of citationHolders(raw)) {
    if (holder.location.startsWith('pt')) continue
    for (const id of new Set(holder.ids)) {
      if (!positions.has(id)) unknownCitations.push({ location: holder.location, id })
    }
  }
  for (const range of raw.skippable) {
    for (const id of expandRange(range, positions, sentences)) accounted.add(id)
  }

  return {
    uncovered: sentences.filter((sentence) => !accounted.has(sentence.id)).map((s) => s.id),
    unknownCitations,
    unprovenQuotes,
    unsourcedPoints,
  }
}

export function applyRepair(raw: RawPlan, repair: RawRepair): RawPlan {
  const repaired = structuredClone(raw)
  const holders = new Map(citationHolders(repaired).map((holder) => [holder.location, holder]))
  for (const correction of repair.corrections) {
    holders.get(correction.location)?.replace(correction.wrongId, correction.rightId.trim(), correction.quote)
  }
  repaired.skippable = repaired.skippable.filter(
    (range) => range.fromSentenceId && range.toSentenceId,
  )
  const points = eachPoint(repaired)
  for (const added of repair.addedQuotes) {
    const match = /^pt(\d+)$/.exec(added.location.trim())
    const point = match ? points[Number(match[1]) - 1] : undefined
    point?.quotes.push({ sentenceId: added.sentenceId, quote: added.quote })
  }
  for (const added of repair.addedPoints) {
    const match = /^st(\d+)$/.exec(added.stepId.trim())
    const step = match ? repaired.steps[Number(match[1]) - 1] : undefined
    step?.points.push(added.point)
  }
  repaired.skippable.push(...repair.addedSkippable)
  return repaired
}

/** Joins separately planned parts, keeping problem order across the whole text. */
export function mergeRawPlans(raws: readonly RawPlan[]): RawPlan {
  if (raws.length === 1) return raws[0]
  const steps = raws.flatMap((raw) => raw.steps)
  return { title: raws[0].title, steps: PLAN_STEP_KINDS.flatMap((kind) => steps.filter((step) => step.kind === kind)), questions: raws.flatMap(r=>r.questions), pageNotes: raws.flatMap(r=>r.pageNotes), skippable: raws.flatMap((raw) => raw.skippable), figures: raws.flatMap((raw) => raw.figures) }
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}

function needsSpaceBetween(before: string, after: string): boolean { const last=before.at(-1); const first=after[0]; if(last===undefined||first===undefined) return false; return !(/\s/.test(last)||/\s/.test(first)) }

function stickingPointsOf(point: RawPoint): { spoken: string; stickingPoints: PlanStickingPoint[] } {
  let spoken = ''
  const stickingPoints: PlanStickingPoint[] = []
  for (const segment of point.spoken) {
    if (needsSpaceBetween(spoken, segment.text)) spoken += ' '
    if (segment.pauseBefore) {
      stickingPoints.push({ offset: spoken.length, reason: segment.stuckReason.trim() })
    }
    spoken += segment.text
  }
  return { spoken, stickingPoints }
}

export interface StoredPlanInput { fingerprint: string; model: string
  promptVersion: string
  createdAt: string
  raw: RawPlan
  sentences: readonly Sentence[]
  pageCount: number
  citations: readonly Citation[]
  volume: PlanVolume
  usage: PlanUsage
  repaired: boolean
  droppedQuotes: number
}

export function toStoredPlan(input: StoredPlanInput): Plan {
  const { raw, sentences } = input
  const resolver = new SourceResolver(input.citations)
  const isKnownPage = (page: number) => page >= 1 && page <= input.pageCount

  const covered = new Set<string>()
  const questions: PlanQuestion[] = []
  const flatIds: string[] = []
  let pointNumber = 0
  const steps: PlanStep[] = raw.steps.map((step, stepIndex) => {
    const stepId = `st${stepIndex + 1}`
    const points: PlanPoint[] = step.points.map((point) => {
      pointNumber += 1
      const { spoken, stickingPoints } = stickingPointsOf(point)
      const sentenceIds = unique(point.quotes.map((quote) => quote.sentenceId))
      for (const id of sentenceIds) covered.add(id)
      flatIds.push(`pt${pointNumber}`)
      return { id: `pt${pointNumber}`, stepId, spoken, stickingPoints, sentenceIds, quotes: point.quotes, source: resolver.resolve(point.source), figurePages: unique(point.figurePages).filter(isKnownPage), figurePart: point.figurePart && point.figurePart.page>=1 && isKnownPage(point.figurePart.page) && point.figurePart.concept.trim() ? { page: point.figurePart.page, region: point.figurePart.hasRegion ? point.figurePart.region : null, concept: point.figurePart.concept.trim() } : null }
    })
    return { id: stepId, kind: step.kind, title: step.title, points }
  })

  for (const q of raw.questions) { const after = flatIds[q.afterPointIndex-1]; if(after) questions.push({ id: `q${questions.length+1}`, afterPointId: after, question: q.question, guidance: q.guidance, earnsSentenceIds: unique(q.earnsSentenceIds) }) }
  const byId = new Map(sentences.map(s=>[s.id,s]))
  const pageNotes: PageNote[] = []; let droppedPageNotes=0
  for (const n of raw.pageNotes) { const s=byId.get(n.sentenceId); if(!s){droppedPageNotes++;continue} const start=s.text.indexOf(n.anchor); if(start===-1||!n.anchor){droppedPageNotes++;continue} pageNotes.push({ id:`note${pageNotes.length+1}`, sentenceId:n.sentenceId, anchor:n.anchor, note:n.note, start, end:start+n.anchor.length, boxes: [] }) }
  const positions = positionsOf(sentences)
  const reasons = new Map<string, string>()
  for (const range of raw.skippable) {
    for (const id of expandRange(range, positions, sentences)) {
      if (!covered.has(id) && !reasons.has(id)) reasons.set(id, range.reason)
    }
  }

  return { fingerprint: input.fingerprint, model: input.model,
    promptVersion: input.promptVersion,
    createdAt: input.createdAt,
    title: raw.title,
    steps,
    skippable: sentences
      .filter((sentence) => reasons.has(sentence.id))
      .map((sentence) => ({ sentenceId: sentence.id, reason: reasons.get(sentence.id) as string })),
    pageNotes,
    droppedPageNotes,
    questions,
    figures: raw.figures
      .filter((figure) => isKnownPage(figure.page))
      .map((figure, index) => ({
        id: `fig${index + 1}`,
        page: figure.page,
        label: figure.label,
        description: figure.description,
      })),
    volume: input.volume,
    sourcing: resolver.summary(),
    coverage: {
      total: sentences.length,
      covered: sentences.filter((sentence) => covered.has(sentence.id)).length,
      skippable: reasons.size,
      uncovered: sentences
        .filter((sentence) => !covered.has(sentence.id) && !reasons.has(sentence.id))
        .map((sentence) => sentence.id),
    },
    usage: input.usage,
    repaired: input.repaired,
    droppedQuotes: input.droppedQuotes,
  }
}
