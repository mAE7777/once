import type {
  Plan,
  PlanFigure,
  PlanPoint,
  PlanStep,
  SentenceState,
} from '@/lib/types'
import type { VerificationReport } from '@/verify/verify'

export interface FlatPoint {
  point: PlanPoint
  step: PlanStep
  index: number
}

/** The one ordered list every part of the reader walks: steps in order, points in order. */
export function flattenPoints(plan: Plan): FlatPoint[] {
  const flat: FlatPoint[] = []
  for (const step of plan.steps) {
    for (const point of step.points) {
      flat.push({ point, step, index: flat.length })
    }
  }
  return flat
}

export function clampPointIndex(index: number, total: number): number {
  if (total <= 0) return 0
  if (!Number.isFinite(index)) return 0
  return Math.min(Math.max(Math.trunc(index), 0), total - 1)
}

export function nextPointIndex(index: number, total: number): number {
  return clampPointIndex(index + 1, total)
}

export function prevPointIndex(index: number, total: number): number {
  return clampPointIndex(index - 1, total)
}

/** At any moment, exactly the current point's sentences are lit. Nothing else is. */
export function litSentenceIds(flat: readonly FlatPoint[], index: number): string[] {
  const current = flat[clampPointIndex(index, flat.length)]
  return current ? [...current.point.sentenceIds] : []
}

export function pointIndexForSentence(flat: readonly FlatPoint[], sentenceId: string): number {
  return flat.findIndex((entry) => entry.point.sentenceIds.includes(sentenceId))
}

export function pointIndexById(flat: readonly FlatPoint[], pointId: string): number {
  return flat.findIndex((entry) => entry.point.id === pointId)
}

/**
 * What each sentence shows for this reader. The report says the plan covers a sentence, which is
 * not the same as the reader having reached it, so its `explained` entries carry no mark here.
 */
export function effectiveStates(
  starting: Record<string, SentenceState>,
  server: Record<string, SentenceState>,
): Record<string, SentenceState> {
  const shown: Record<string, SentenceState> = {}
  for (const [id, state] of Object.entries(starting)) {
    if (state !== 'explained') shown[id] = state
  }
  return { ...shown, ...server }
}

/**
 * The sentences of a point that still need an `explained` mark sent to the server.
 * Understood and already explained sentences are left alone, so moving back and
 * forth never rewrites a stronger mark with a weaker one.
 */
export function markBatch(
  known: Record<string, SentenceState>,
  sentenceIds: readonly string[],
): string[] {
  return sentenceIds.filter((id) => known[id] !== 'explained' && known[id] !== 'understood')
}

/** What the marks should look like the moment a point is reached, before the server replies. */
export function statesAfterArrival(
  known: Record<string, SentenceState>,
  sentenceIds: readonly string[],
): Record<string, SentenceState> {
  const next = { ...known }
  for (const id of sentenceIds) {
    if (next[id] !== 'understood') next[id] = 'explained'
  }
  return next
}

/** Folds the states the server actually stored back over the local copy. */
export function applyMarkResult(
  known: Record<string, SentenceState>,
  result: Record<string, SentenceState>,
): Record<string, SentenceState> {
  return { ...known, ...result }
}

export interface ReaderProgress {
  reached: number
  understood: number
  total: number
  percent: number
}

export function readerProgress(
  states: Record<string, SentenceState>,
  total: number,
): ReaderProgress {
  let reached = 0
  let understood = 0
  for (const state of Object.values(states)) {
    if (state === 'explained' || state === 'understood') reached += 1
    if (state === 'understood') understood += 1
  }
  return {
    reached,
    understood,
    total,
    percent: total > 0 ? Math.round((reached / total) * 100) : 0,
  }
}

export function uncoveredIds(report: VerificationReport): string[] {
  return [...report.coverage.uncoveredIds]
}

export function skippableReasons(plan: Plan): Map<string, string> {
  return new Map(plan.skippable.map((entry) => [entry.sentenceId, entry.reason]))
}

export function figuresForPoint(
  figures: readonly PlanFigure[],
  point: PlanPoint,
): PlanFigure[] {
  const pages = new Set(point.figurePages)
  return figures.filter((figure) => pages.has(figure.page))
}

/** A point with sticking points asks for the stop-and-think beat until the reader moves past it. */
export function needsStickingGate(point: PlanPoint, dismissed: ReadonlySet<string>): boolean {
  return point.stickingPoints.length > 0 && !dismissed.has(point.id)
}

export interface ReaderPlace {
  index: number
  section?: number
  point?: number
  dismissedGateIds: string[]
}

export function placeStorageKey(fingerprint: string): string {
  return `once-place:${fingerprint}`
}

export function serializePlace(place: ReaderPlace): string {
  return JSON.stringify({
    index: place.index,
    section: place.section,
    point: place.point,
    dismissedGateIds: [...new Set(place.dismissedGateIds)],
  })
}

/** Reopening restores the exact point. Corrupt or out-of-range saved places fall back safely. */
export function parsePlace(raw: string | null, total: number): ReaderPlace {
  if (raw === null) return { index: 0, dismissedGateIds: [] }
  try {
    const parsed = JSON.parse(raw) as { index?: unknown; section?: unknown; point?: unknown; dismissedGateIds?: unknown }
    const dismissed = Array.isArray(parsed.dismissedGateIds)
      ? parsed.dismissedGateIds.filter((id): id is string => typeof id === 'string')
      : []
    const index =
      typeof parsed.index === 'number' ? clampPointIndex(parsed.index, total) : 0
    const section = typeof parsed.section === 'number' ? Math.max(0, Math.trunc(parsed.section)) : undefined
    const point = typeof parsed.point === 'number' ? Math.max(0, Math.trunc(parsed.point)) : undefined
    return { index, section, point, dismissedGateIds: dismissed }
  } catch {
    return { index: 0, dismissedGateIds: [] }
  }
}
