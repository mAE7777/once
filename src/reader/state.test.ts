import { describe, expect, it } from 'vitest'
import type { Plan, PlanPoint, SentenceState } from '@/lib/types'
import type { VerificationReport } from '@/verify/verify'
import {
  applyMarkResult,
  clampPointIndex,
  effectiveStates,
  figuresForPoint,
  flattenPoints,
  litSentenceIds,
  markBatch,
  needsStickingGate,
  nextPointIndex,
  parsePlace,
  pointIndexForSentence,
  prevPointIndex,
  readerProgress,
  serializePlace,
  skippableReasons,
  statesAfterArrival,
  uncoveredIds,
} from './state'

function point(id: string, sentenceIds: string[], extra: Partial<PlanPoint> = {}): PlanPoint {
  return {
    id,
    stepId: 'step-1',
    spoken: `Spoken text for ${id}.`,
    stickingPoints: [],
    sentenceIds,
    quotes: sentenceIds.map((sentenceId) => ({ sentenceId, quote: `text of ${sentenceId}` })),
    source: { kind: 'original', url: null, title: null },
    figurePages: [],
    figurePart: null,
    ...extra,
  }
}

function planWith(pointsByStep: PlanPoint[][]): Plan {
  return {
    fingerprint: 'fp',
    model: 'test',
    promptVersion: 'test',
    createdAt: '2026-01-01T00:00:00.000Z',
    title: 'Test plan',
    steps: pointsByStep.map((points, i) => ({
      id: `step-${i + 1}`,
      kind: (['context', 'problem'] as const)[i] ?? 'answer',
      title: `Step ${i + 1}`,
      points: points.map((p) => ({ ...p, stepId: `step-${i + 1}` })),
    })),
    skippable: [{ sentenceId: 's9', reason: 'A repeated heading.' }],
    pageNotes: [], droppedPageNotes: 0,
    questions: [],
    figures: [{ id: 'f1', page: 3, label: 'Figure 1', description: 'The whole model.' }],
    volume: { split: false, reason: null, note: null, parts: [], imagePages: [], missingImagePages: [] },
    sourcing: { externalKept: 0, downgradedToInference: 0, links: [] },
    coverage: { total: 4, covered: 3, skippable: 1, uncovered: [] },
    usage: { calls: 1, inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningTokens: 0, webSearches: 0 },
    repaired: false,
    droppedQuotes: 0,
  }
}

const plan = planWith([
  [point('p1', ['s1', 's3']), point('p2', ['s2'])],
  [point('p3', ['s3', 's4'], { figurePages: [3], stickingPoints: [{ offset: 4, reason: 'A dense formula.' }] })],
])
const flat = flattenPoints(plan)

describe('flattenPoints and lit sentences', () => {
  it('keeps steps and points in problem order', () => {
    expect(flat.map((entry) => entry.point.id)).toEqual(['p1', 'p2', 'p3'])
    expect(flat.map((entry) => entry.index)).toEqual([0, 1, 2])
  })

  it('lights exactly the current point sentences, including non-adjacent ones', () => {
    expect(litSentenceIds(flat, 0)).toEqual(['s1', 's3'])
    expect(litSentenceIds(flat, 1)).toEqual(['s2'])
    expect(litSentenceIds(flat, 2)).toEqual(['s3', 's4'])
  })

  it('lights nothing outside the plan and clamps the index', () => {
    expect(litSentenceIds(flat, 99)).toEqual(['s3', 's4'])
    expect(litSentenceIds([], 0)).toEqual([])
    expect(clampPointIndex(-2, 3)).toBe(0)
    expect(nextPointIndex(2, 3)).toBe(2)
    expect(prevPointIndex(0, 3)).toBe(0)
    expect(nextPointIndex(0, 3)).toBe(1)
  })

  it('finds the first point that cites a sentence', () => {
    expect(pointIndexForSentence(flat, 's3')).toBe(0)
    expect(pointIndexForSentence(flat, 's4')).toBe(2)
    expect(pointIndexForSentence(flat, 'nope')).toBe(-1)
  })
})

describe('marks', () => {
  it('keeps the explained mark after moving on to later points', () => {
    let states: Record<string, SentenceState> = {}
    states = statesAfterArrival(states, litSentenceIds(flat, 0))
    expect(states).toEqual({ s1: 'explained', s3: 'explained' })
    states = statesAfterArrival(states, litSentenceIds(flat, 1))
    expect(states.s1).toBe('explained')
    expect(states.s3).toBe('explained')
    expect(states.s2).toBe('explained')
    states = statesAfterArrival(states, litSentenceIds(flat, 2))
    expect(states.s1).toBe('explained')
  })

  it('never sends a weaker mark over understood or explained sentences', () => {
    const known: Record<string, SentenceState> = { s1: 'understood', s2: 'explained' }
    expect(markBatch(known, ['s1', 's2', 's3'])).toEqual(['s3'])
    const after = statesAfterArrival(known, ['s1', 's3'])
    expect(after.s1).toBe('understood')
    expect(after.s3).toBe('explained')
  })

  it('lets server marks win over starting states, and folds mark results back', () => {
    const merged = effectiveStates(
      { s1: 'explained', s2: 'uncovered', s3: 'skippable' },
      { s2: 'understood' },
    )
    expect(merged).toEqual({ s2: 'understood', s3: 'skippable' })
    expect(readerProgress(merged, 4)).toEqual({ reached: 1, understood: 1, total: 4, percent: 25 })
    const reached = applyMarkResult(merged, { s1: 'explained' })
    expect(reached).toEqual({ s1: 'explained', s2: 'understood', s3: 'skippable' })
    expect(readerProgress(reached, 4)).toEqual({ reached: 2, understood: 1, total: 4, percent: 50 })
  })

  it('shows no covered mark on a sentence the reader has not reached yet', () => {
    const first = effectiveStates({ s1: 'explained', s2: 'explained' }, {})
    expect(first).toEqual({})
    expect(readerProgress(first, 2).reached).toBe(0)
  })
})

describe('restoring position', () => {
  it('round-trips the exact point and dismissed gates', () => {
    const raw = serializePlace({ index: 2, dismissedGateIds: ['p3'] })
    expect(parsePlace(raw, flat.length)).toEqual({ index: 2, dismissedGateIds: ['p3'] })
  })

  it('clamps a saved point past the end and survives corrupt saves', () => {
    expect(parsePlace(JSON.stringify({ index: 99 }), flat.length).index).toBe(2)
    expect(parsePlace('not json', flat.length)).toEqual({ index: 0, dismissedGateIds: [] })
    expect(parsePlace(null, flat.length)).toEqual({ index: 0, dismissedGateIds: [] })
  })
})

describe('point helpers', () => {
  it('matches figures to the point that needs them', () => {
    expect(figuresForPoint(plan.figures, flat[2].point).map((f) => f.id)).toEqual(['f1'])
    expect(figuresForPoint(plan.figures, flat[0].point)).toEqual([])
  })

  it('gates only points with sticking points that are not yet dismissed', () => {
    expect(needsStickingGate(flat[2].point, new Set())).toBe(true)
    expect(needsStickingGate(flat[2].point, new Set(['p3']))).toBe(false)
    expect(needsStickingGate(flat[0].point, new Set())).toBe(false)
    expect(skippableReasons(plan).get('s9')).toBe('A repeated heading.')
  })

  it('passes uncovered ids through from the report', () => {
    const report = {
      coverage: { uncoveredIds: ['s7'] },
    } as unknown as VerificationReport
    expect(uncoveredIds(report)).toEqual(['s7'])
  })
})
