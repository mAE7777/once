import type { Plan, PlanPoint, PlanSource, Sentence } from '@/lib/types'

const ORIGINAL: PlanSource = { kind: 'original', url: null, title: null }

function point(id: string, stepId: string, spoken: string, sentenceIds: string[]): PlanPoint {
  return {
    id,
    stepId,
    spoken,
    stickingPoints: [],
    sentenceIds,
    quotes: [],
    source: ORIGINAL,
    figurePages: [],
    figurePart: null,
  }
}

/** A finished plan over the given sentences, with one entry of each kind per real sentence. */
export function planOver(fingerprint: string, sentences: readonly Sentence[]): Plan {
  const [first, second, third] = sentences
  return {
    fingerprint,
    model: 'test-model',
    promptVersion: 'test-prompt',
    createdAt: '2026-01-01T00:00:00.000Z',
    title: 'A plan',
    steps: [
      {
        id: 'st1',
        kind: 'problem',
        title: 'The problem',
        points: [
          point('pt1', 'st1', 'Hand translation was slow. It took years to learn.', [second.id, first.id]),
        ],
      },
      {
        id: 'st2',
        kind: 'answer',
        title: 'The answer',
        points: [point('pt2', 'st2', 'Attention looks back at the input.', [third.id])],
      },
    ],
    skippable: [],
    pageNotes: [],
    droppedPageNotes: 0,
    questions: [{ id: 'q1', afterPointId: 'pt1', question: 'You are translating by hand and it takes years to learn. Why was it slow?', guidance: 'A strong answer says it was done by hand.', earnsSentenceIds: [first.id] }],
    figures: [],
    volume: {
      split: false,
      reason: null,
      note: null,
      parts: [],
      imagePages: [],
      missingImagePages: [],
    },
    sourcing: { externalKept: 0, downgradedToInference: 0, links: [] },
    coverage: { total: sentences.length, covered: 3, skippable: 0, uncovered: [] },
    usage: {
      calls: 1,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      webSearches: 0,
    },
    repaired: false,
    droppedQuotes: 0,
  }
}
