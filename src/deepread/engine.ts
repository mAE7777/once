import { MetaApiError } from '@/lib/meta'
import type {
  PlanCheckCounts,
  PlanCheckFinding,
  PlanEngineReport,
  PlanStageRecord,
  PlanUsage,
  ReadableDocument,
  Sentence,
} from '@/lib/types'
import { getArtifact, putArtifact, readArtifact } from '@/store/store'
import { MAX_PLAN_ATTEMPTS, MAX_REPAIR_ATTEMPTS, PlanCoverageError, PlanModelError, callModel, costOf, emptyUsage, sumUsage } from './call'
import { lintNarration, type NarrationPoint } from './lints'
import {
  SourceResolver,
  applyRepair,
  auditIsClean,
  auditPlan,
  dropUnprovenQuotes,
  mergeRawPlans,
  settleQuotes,
  type Citation,
} from './normalize'
import { loadPageImages, type VolumeSplit } from './pages'
import { PLAN_MODEL, PROMPT_VERSION, buildRepairRequest } from './prompt'
import { PLAN_REPAIR_SCHEMA, validateAgainstSchema, type RawPlan, type RawRepair } from './schema'
import {
  LISTENER_SCHEMA,
  RESEARCH_SCHEMA,
  REWRITE_SCHEMA,
  SECTION_SCHEMA,
  UNDERSTAND_SCHEMA,
  buildListenerRequest,
  buildOutlineRequest,
  buildResearchRequest,
  buildRewriteRequest,
  buildSectionRequest,
  buildUnderstandRequest,
  checkOutline,
  type Finding,
  type ListenerReport,
  type Outline,
  type Rewrite,
  type Understanding,
  type WrittenSection,
} from './stages'

export const ENGINE_ARTIFACT_KIND = 'engine'
export const MAX_REPAIR_ROUNDS = 3
export const SECTION_CONCURRENCY = 8
const POINTS_PER_REWRITE = 15

/**
 * An outline with too few sections for its text leaves a listener nothing to move through, and the sentences it
 * forgets all land in one place later. Such an outline is sent back while attempts remain.
 */
export function outlineShapeProblems(outline: Outline, sentences: readonly Sentence[]): string[] {
  const wanted = sentences.length <= 15 ? 1 : sentences.length <= 200 ? 3 : 5
  return outline.sections.length < wanted ? [`This text needs at least ${wanted} sections; the outline has ${outline.sections.length}.`] : []
}

// A plan missing more than this share of its sentences is not an explanation of the text.
const MAX_UNCOVERED_SHARE = 0.25

export type EngineStage = 'understanding' | 'researching' | 'outlining' | 'writing' | 'checking' | 'repairing'

export interface EngineContext {
  fingerprint: string
  document: ReadableDocument
  sentences: readonly Sentence[]
  split: VolumeSplit
  usage: PlanUsage
  fetchImpl: typeof fetch
  sleep: (ms: number) => Promise<void>
  onStage: (stage: EngineStage) => void
  now?: () => number
  startedAt: number
}

export interface EngineResult {
  raw: RawPlan
  citations: Citation[]
  missingImages: number[]
  repaired: boolean
  droppedQuotes: number
  report: PlanEngineReport
}

interface StoredStage<T> {
  value: T
  citations: Citation[]
  usage: PlanUsage
  ms: number
}

class StageLog {
  private readonly records = new Map<string, PlanStageRecord>()

  add(name: string, ms: number, calls: number): void {
    const record = this.records.get(name) ?? { name, ms: 0, calls: 0 }
    record.ms += ms
    record.calls += calls
    this.records.set(name, record)
  }

  all(): PlanStageRecord[] {
    return [...this.records.values()]
  }
}

/** Runs a stage once per fingerprint and version. A crash resumes from the stored results. */
async function stage<T>(
  context: EngineContext,
  log: StageLog,
  name: string,
  key: string,
  run: (usage: PlanUsage) => Promise<{ value: T; citations: Citation[] }>,
): Promise<StoredStage<T>> {
  const found = getArtifact(context.fingerprint, ENGINE_ARTIFACT_KIND, key, { model: PLAN_MODEL, promptVersion: PROMPT_VERSION })
  if (found?.isCurrent) {
    const stored = JSON.parse(readArtifact(found.path).toString('utf8')) as StoredStage<T>
    sumUsage(context.usage, stored.usage)
    log.add(name, stored.ms, stored.usage.calls)
    return stored
  }
  const started = Date.now()
  const usage = emptyUsage()
  try {
    const { value, citations } = await run(usage)
    const stored: StoredStage<T> = { value, citations, usage, ms: Date.now() - started }
    putArtifact({
      fingerprint: context.fingerprint,
      kind: ENGINE_ARTIFACT_KIND,
      key,
      model: PLAN_MODEL,
      promptVersion: PROMPT_VERSION,
      data: Buffer.from(JSON.stringify(stored), 'utf8'),
    })
    log.add(name, stored.ms, usage.calls)
    return stored
  } finally {
    sumUsage(context.usage, usage)
  }
}

async function mapLimit<T, R>(items: readonly T[], limit: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await run(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

function isSoftFailure(error: unknown): boolean {
  if (error instanceof PlanModelError) return true
  return error instanceof MetaApiError && error.status !== 0
}

function expandRanges(
  ranges: readonly { fromSentenceId: string; toSentenceId: string }[],
  positions: Map<string, number>,
  sentences: readonly Sentence[],
): string[] {
  const ids: string[] = []
  for (const range of ranges) {
    const from = positions.get(range.fromSentenceId)
    const to = positions.get(range.toSentenceId)
    if (from === undefined || to === undefined) continue
    for (let index = Math.min(from, to); index <= Math.max(from, to); index += 1) ids.push(sentences[index].id)
  }
  return ids
}

/**
 * Turns the outline's ranges into each section's sentences. Anything the outline left out goes to
 * the section holding the sentence just before it, so a writer still has to explain it.
 */
export function assignSentences(outline: Outline, sentences: readonly Sentence[]): Sentence[][] {
  const positions = new Map(sentences.map((sentence, index) => [sentence.id, index]))
  const owner = new Map<string, number>()
  outline.sections.forEach((section, index) => {
    for (const id of expandRanges(section.sentenceRanges, positions, sentences)) {
      if (!owner.has(id)) owner.set(id, index)
    }
  })
  const skipped = new Set(expandRanges(outline.skippable, positions, sentences))
  const assigned: Sentence[][] = outline.sections.map(() => [])
  let lastOwner = 0
  for (const sentence of sentences) {
    const known = owner.get(sentence.id)
    if (known !== undefined) {
      lastOwner = known
      assigned[known].push(sentence)
    } else if (!skipped.has(sentence.id)) {
      assigned[lastOwner].push(sentence)
    }
  }
  return assigned
}

function cleanSpoken(text: string): string {
  return text.replace(/\s+[—–]\s+/g, ', ')
}

function assemble(outline: Outline, written: readonly (WrittenSection | null)[], understanding: Understanding): RawPlan {
  const raw: RawPlan = { title: outline.title, steps: [], questions: [], pageNotes: [], skippable: outline.skippable, figures: understanding.figures }
  let pointsSoFar = 0
  outline.sections.forEach((section, index) => {
    const content = written[index]
    if (!content) return
    raw.steps.push({
      kind: section.kind,
      title: section.title,
      points: content.points.map((point) => ({
        ...point,
        spoken: point.spoken.map((segment) => ({ ...segment, text: cleanSpoken(segment.text) })),
      })),
    })
    for (const question of content.questions) {
      raw.questions.push({
        afterPointIndex: pointsSoFar + Math.min(question.afterPointInSection, content.points.length),
        question: question.question,
        guidance: question.guidance,
        earnsSentenceIds: question.earnsSentenceIds,
      })
    }
    raw.pageNotes.push(...content.pageNotes)
    pointsSoFar += content.points.length
  })
  return raw
}

interface PartResult {
  raw: RawPlan
  citations: Citation[]
  missingImages: number[]
  repaired: boolean
  droppedQuotes: number
  notes: string[]
}

async function planPart(
  context: EngineContext,
  log: StageLog,
  partIndex: number,
  sentences: readonly Sentence[],
  imagePages: readonly number[],
  partLabel: string | null,
): Promise<PartResult> {
  const shared = { fetchImpl: context.fetchImpl, sleep: context.sleep }
  const base = { fingerprint: context.fingerprint }
  const prefix = `p${partIndex}`
  const notes: string[] = []

  context.onStage('understanding')
  const { images, missing } = await loadPageImages(context.document, imagePages)
  const understood = await stage<Understanding>(context, log, 'understand', `${prefix}:understand`, (usage) =>
    callModel<Understanding>({
      ...shared,
      usage,
      body: buildUnderstandRequest({ ...base, sentences, images, partLabel }),
      check: (value) => validateAgainstSchema(value, UNDERSTAND_SCHEMA),
      maxAttempts: MAX_PLAN_ATTEMPTS,
      what: 'close reading of the text',
    }),
  )
  const understanding = understood.value

  context.onStage('researching')
  let findings: Finding[] = []
  let citations: Citation[] = []
  if (understanding.researchQuestions.length > 0) {
    const answers = await mapLimit(understanding.researchQuestions, SECTION_CONCURRENCY, async (question, questionIndex) => {
      try {
        return await stage<{ findings: Finding[] }>(context, log, 'research', `${prefix}:research:${questionIndex}`, (usage) =>
          callModel<{ findings: Finding[] }>({
            ...shared,
            usage,
            body: buildResearchRequest({ ...base, title: understanding.title, question }),
            check: (value) => validateAgainstSchema(value, RESEARCH_SCHEMA),
            maxAttempts: MAX_PLAN_ATTEMPTS,
            what: 'research',
          }),
        )
      } catch (error) {
        if (!isSoftFailure(error)) throw error
        return null
      }
    })
    if (answers.some((answer) => answer === null)) {
      notes.push('Some of the web research could not be completed, so that background comes from the model\'s own knowledge and is labeled as inference.')
    }
    citations = answers.flatMap((answer) => answer?.citations ?? [])
    findings = keepRetrievedLinks(answers.flatMap((answer) => answer?.value.findings ?? []), citations)
  }

  context.onStage('outlining')
  let outlineTries = 0
  const outlined = await stage<Outline>(context, log, 'outline', `${prefix}:outline`, (usage) =>
    callModel<Outline>({
      ...shared,
      usage,
      body: buildOutlineRequest({ ...base, sentences, understanding, findings, partLabel }),
      // A badly shaped outline gets every attempt but the last; the last is taken if it parses, so a text still gets read.
      check: (value) => {
        outlineTries += 1
        const errors = checkOutline(value)
        return errors.length > 0 || outlineTries >= MAX_PLAN_ATTEMPTS ? errors : outlineShapeProblems(value as Outline, sentences)
      },
      maxAttempts: MAX_PLAN_ATTEMPTS,
      what: 'outline of the explanation',
    }),
  )
  const outline = outlined.value
  const assigned = assignSentences(outline, sentences)

  context.onStage('writing')
  const written = await mapLimit(outline.sections, SECTION_CONCURRENCY, async (_section, sectionIndex) => {
    if (assigned[sectionIndex].length === 0) return null
    const result = await stage<WrittenSection>(context, log, 'write', `${prefix}:section:${sectionIndex}`, (usage) =>
      callModel<WrittenSection>({
        ...shared,
        usage,
        body: buildSectionRequest({ ...base, outline, understanding, findings, sectionIndex, sentences: assigned[sectionIndex] }),
        check: (value) => validateAgainstSchema(value, SECTION_SCHEMA),
        maxAttempts: MAX_PLAN_ATTEMPTS,
        what: `explanation of section ${sectionIndex + 1}`,
      }),
    )
    return result.value
  })

  const settled = settleQuotes(assemble(outline, written, understanding), sentences)
  const audit = auditPlan(settled, sentences)
  if (auditIsClean(audit)) {
    return { raw: settled, citations, missingImages: missing, repaired: false, droppedQuotes: 0, notes }
  }

  const repair = await stage<RawRepair>(context, log, 'coverage', `${prefix}:coverage`, (usage) =>
    callModel<RawRepair>({
      ...shared,
      usage,
      body: buildRepairRequest({ ...base, sentences, raw: settled, audit, partLabel }),
      check: (value) => validateAgainstSchema(value, PLAN_REPAIR_SCHEMA),
      maxAttempts: MAX_REPAIR_ATTEMPTS,
      what: 'repair of the explanation plan',
    }),
  )
  const { raw: repaired, dropped } = dropUnprovenQuotes(settleQuotes(applyRepair(settled, repair.value), sentences), sentences)
  const after = auditPlan(repaired, sentences)
  for (const step of repaired.steps) step.points = step.points.filter((point) => point.quotes.length > 0)
  repaired.steps = repaired.steps.filter((step) => step.points.length > 0)
  const unusable =
    repaired.steps.length === 0 ||
    after.uncovered.length > sentences.length * MAX_UNCOVERED_SHARE
  if (unusable) throw new PlanCoverageError(after)
  if (after.uncovered.length > 0) {
    notes.push(`${after.uncovered.length} sentence(s) are neither explained nor marked skippable: ${after.uncovered.slice(0, 20).join(', ')}.`)
  }
  return { raw: repaired, citations, missingImages: missing, repaired: true, droppedQuotes: dropped, notes }
}

function keepRetrievedLinks(findings: readonly Finding[], citations: readonly Citation[]): Finding[] {
  return findings.map((finding) => {
    const resolved = new SourceResolver(citations).resolve({ kind: 'external', url: finding.url, title: finding.title })
    return resolved.kind === 'external'
      ? { ...finding, url: resolved.url as string, title: resolved.title ?? finding.title }
      : { ...finding, url: '', title: '' }
  })
}

export function narrationOf(raw: RawPlan): NarrationPoint[] {
  let number = 0
  return raw.steps.flatMap((step) =>
    step.points.map((point) => {
      number += 1
      return { pointId: `pt${number}`, text: point.spoken.map((segment) => segment.text).join(' ').replace(/\s+/g, ' ').trim() }
    }),
  )
}

/** Keeps only what the listener can back up: real points, and untaught words really in them. */
export function listenerFindings(report: ListenerReport, narration: readonly NarrationPoint[]): PlanCheckFinding[] {
  const textOf = new Map(narration.map((point) => [point.pointId, point.text.toLowerCase()]))
  const findings: PlanCheckFinding[] = []
  for (const entry of report.points) {
    const text = textOf.get(entry.pointId)
    if (text === undefined) continue
    for (const word of entry.untaught) {
      if (!text.includes(word.words.toLowerCase().trim())) continue
      findings.push({ pointId: entry.pointId, kind: 'untaught', detail: `"${word.words}": ${word.why}` })
    }
    for (const detail of entry.jumps) findings.push({ pointId: entry.pointId, kind: 'jump', detail })
    for (const detail of entry.abstractWithNoSituation) findings.push({ pointId: entry.pointId, kind: 'abstract', detail })
    for (const detail of entry.couldNotRetell) findings.push({ pointId: entry.pointId, kind: 'could-not-retell', detail })
    for (const detail of entry.contradicts) findings.push({ pointId: entry.pointId, kind: 'contradiction', detail })
    for (const detail of entry.repeats) findings.push({ pointId: entry.pointId, kind: 'repeat', detail })
    for (const detail of entry.soundsWrong) findings.push({ pointId: entry.pointId, kind: 'sounds-wrong', detail })
  }
  return findings
}

function countFindings(raw: RawPlan, lints: readonly PlanCheckFinding[], heard: readonly PlanCheckFinding[]): PlanCheckCounts {
  let number = 0
  const sectionOf = new Map<string, number>()
  raw.steps.forEach((step, stepIndex) => {
    for (const _point of step.points) {
      number += 1
      sectionOf.set(`pt${number}`, stepIndex)
    }
  })
  const untaughtSections = new Set(heard.filter((entry) => entry.kind === 'untaught').map((entry) => sectionOf.get(entry.pointId)))
  return { lint: lints.length, listener: heard.length, sectionsWithUntaught: untaughtSections.size, sections: raw.steps.length }
}

function applyRewrite(raw: RawPlan, rewrite: Rewrite, allowed: ReadonlySet<string>): RawPlan {
  const next = structuredClone(raw)
  const points = next.steps.flatMap((step) => step.points)
  for (const entry of rewrite.points) {
    if (!allowed.has(entry.pointId)) continue
    const match = /^pt(\d+)$/.exec(entry.pointId)
    const point = match ? points[Number(match[1]) - 1] : undefined
    if (!point || entry.spoken.length === 0) continue
    point.spoken = entry.spoken.map((segment) => ({ ...segment, text: cleanSpoken(segment.text) }))
  }
  return next
}

interface Version {
  raw: RawPlan
  lints: PlanCheckFinding[]
  heard: PlanCheckFinding[]
  listener: ListenerReport | null
}

async function checkAndRepair(context: EngineContext, log: StageLog, start: RawPlan, notes: string[]) {
  const shared = { fetchImpl: context.fetchImpl, sleep: context.sleep }
  const base = { fingerprint: context.fingerprint }
  const textOf = new Map(context.sentences.map((sentence) => [sentence.id, sentence.text]))
  const now = context.now ?? Date.now
  let current = start
  let first: PlanCheckCounts | null = null
  let best: Version | null = null
  let rounds = 0

  for (let round = 0; ; round += 1) {
    context.onStage('checking')
    const narration = narrationOf(current)
    const lints = lintNarration(narration)
    let listener: ListenerReport | null = null
    try {
      const heard = await stage<ListenerReport>(context, log, 'listen', `listen:${round}`, (usage) =>
        callModel<ListenerReport>({
          ...shared,
          usage,
          body: buildListenerRequest({ ...base, narration }),
          check: (value) => validateAgainstSchema(value, LISTENER_SCHEMA),
          maxAttempts: MAX_REPAIR_ATTEMPTS,
          what: 'listener check',
        }),
      )
      listener = heard.value
    } catch (error) {
      if (!isSoftFailure(error)) throw error
      notes.push('The fresh listener could not be run on the last version, so that version was not checked by it.')
    }
    const heardFindings = listener ? listenerFindings(listener, narration) : []
    const version: Version = { raw: current, lints, heard: heardFindings, listener }
    first = first ?? countFindings(current, lints, heardFindings)
    const score = (entry: Version) => entry.lints.length + entry.heard.length
    if (!best || !best.listener || (listener && score(version) < score(best))) best = version

    const all = [...lints, ...heardFindings]
    if (all.length === 0 || round >= MAX_REPAIR_ROUNDS || !listener) break

    context.onStage('repairing')
    const byPoint = new Map<string, string[]>()
    for (const entry of all) byPoint.set(entry.pointId, [...(byPoint.get(entry.pointId) ?? []), `${entry.kind}: ${entry.detail}`])
    const points = current.steps.flatMap((step) => step.points)
    const flagged = [...byPoint.entries()].map(([pointId, problems]) => {
      const point = points[Number(pointId.slice(2)) - 1]
      return { pointId, problems, sentences: point.quotes.map((quote) => textOf.get(quote.sentenceId) ?? quote.quote) }
    })
    const chunks: (typeof flagged)[] = []
    for (let index = 0; index < flagged.length; index += POINTS_PER_REWRITE) chunks.push(flagged.slice(index, index + POINTS_PER_REWRITE))
    const allowed = new Set(flagged.map((entry) => entry.pointId))
    try {
      const rewrites = await mapLimit(chunks, SECTION_CONCURRENCY, (chunk, chunkIndex) =>
        stage<Rewrite>(context, log, 'repair', `repair:${round}:${chunkIndex}`, (usage) =>
          callModel<Rewrite>({
            ...shared,
            usage,
            body: buildRewriteRequest({ ...base, narration, flagged: chunk }),
            check: (value) => validateAgainstSchema(value, REWRITE_SCHEMA),
            maxAttempts: MAX_REPAIR_ATTEMPTS,
            what: 'repair of flagged points',
          }),
        ),
      )
      current = rewrites.reduce((raw, rewrite) => applyRewrite(raw, rewrite.value, allowed), current)
      rounds += 1
    } catch (error) {
      if (!isSoftFailure(error)) throw error
      notes.push('A repair round could not be completed, so the best checked version was kept.')
      break
    }
  }
  return { best: best as Version, first: first as PlanCheckCounts, rounds }
}

export async function runEngine(context: EngineContext): Promise<EngineResult> {
  const log = new StageLog()
  const parts: PartResult[] = []
  for (const [index, part] of context.split.parts.entries()) {
    const partSentences = context.sentences.filter((sentence) => sentence.page >= part.fromPage && sentence.page <= part.toPage)
    if (partSentences.length === 0) continue
    const partLabel =
      context.split.parts.length > 1
        ? `part ${index + 1} of ${context.split.parts.length} (pages ${part.fromPage} to ${part.toPage})`
        : null
    parts.push(await planPart(context, log, index, partSentences, part.imagePages, partLabel))
  }

  const merged = mergeRawPlans(parts.map((part) => part.raw))
  const notes = parts.flatMap((part) => part.notes)
  const { best, first, rounds } = await checkAndRepair(context, log, merged, notes)
  const remaining = [...best.lints, ...best.heard]
  return {
    raw: best.raw,
    citations: parts.flatMap((part) => part.citations),
    missingImages: parts.flatMap((part) => part.missingImages),
    repaired: parts.some((part) => part.repaired),
    droppedQuotes: parts.reduce((total, part) => total + part.droppedQuotes, 0),
    report: {
      stages: log.all(),
      repairRounds: rounds,
      before: first,
      after: countFindings(best.raw, best.lints, best.heard),
      remaining,
      retell: best.listener?.retell ?? '',
      newCase: best.listener
        ? `${best.listener.newCase.situation} ${best.listener.newCase.howItApplies} ${best.listener.newCase.whereItBreaks}`
        : '',
      listenerFollowed: best.listener?.followed ?? null,
      costUsd: costOf(context.usage),
      notes,
    },
  }
}
