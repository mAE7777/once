import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Plan, Sentence } from '@/lib/types'
import { closeDb, resetStoreForTests } from '@/store/store'
import { planOver } from './fixtures'
import {
    TraceInputError,
          markSentences,
  readingState,
  recordAnswer,
  } from './traces'

const FINGERPRINT = 'a'.repeat(64)
const ALICE = 'reader-alice'
const BOB = 'reader-bob-1'

function sentence(id: string, page: number): Sentence {
  return { id, page, start: 0, end: 1, text: `Sentence ${id}.`, boxes: [] }
}

const SENTENCES: Sentence[] = [
  sentence('s1', 1),
  sentence('s2', 1),
  sentence('s3', 2),
  sentence('s4', 3),
]


let workDir: string
let previousCwd: string

beforeEach(async () => {
  previousCwd = process.cwd()
  workDir = await mkdtemp(path.join(tmpdir(), 'once-traces-'))
  process.chdir(workDir)
  resetStoreForTests()
})

afterEach(async () => {
  closeDb()
  vi.unstubAllGlobals()
  process.chdir(previousCwd)
  await rm(workDir, { recursive: true, force: true })
})

describe('markSentences', () => {
  it('never lets explained replace understood', () => {
    markSentences(ALICE, FINGERPRINT, ['s1'], 'understood')
    const result = markSentences(ALICE, FINGERPRINT, ['s1', 's2'], 'explained')
    expect(result).toEqual({ s1: 'understood', s2: 'explained' })
    expect(readingState(ALICE, FINGERPRINT).states).toEqual({ s1: 'understood', s2: 'explained' })
  })

  it('moves a state upward and refuses every lower one', () => {
    markSentences(ALICE, FINGERPRINT, ['s1'], 'uncovered')
    markSentences(ALICE, FINGERPRINT, ['s1'], 'explained')
    expect(readingState(ALICE, FINGERPRINT).states.s1).toBe('explained')
    markSentences(ALICE, FINGERPRINT, ['s1'], 'skippable')
    markSentences(ALICE, FINGERPRINT, ['s1'], 'uncovered')
    expect(readingState(ALICE, FINGERPRINT).states.s1).toBe('explained')
    markSentences(ALICE, FINGERPRINT, ['s1'], 'understood')
    expect(readingState(ALICE, FINGERPRINT).states.s1).toBe('understood')
  })

  it('rejects a state that does not exist', () => {
    expect(() => markSentences(ALICE, FINGERPRINT, ['s1'], 'read' as never)).toThrow(TraceInputError)
  })
})

describe('recordAnswer', () => {
  const attempt = {
    readerId: ALICE,
    fingerprint: FINGERPRINT,
    questionId: 'q1',
    sentenceIds: ['s1', 's2'],
  }

  it('keeps every attempt and marks understood only on the correct one', () => {
    markSentences(ALICE, FINGERPRINT, ['s1'], 'explained')

    recordAnswer({ ...attempt, answer: 'Because of magic', correct: false, correction: 'By hand' })
    let state = readingState(ALICE, FINGERPRINT)
    expect(state.states).toEqual({ s1: 'explained' })
    expect(state.answers).toHaveLength(1)
    expect(state.answers[0]).toMatchObject({ correct: false, correction: 'By hand' })

    recordAnswer({ ...attempt, answer: 'Because people did it by hand', correct: true })
    state = readingState(ALICE, FINGERPRINT)
    expect(state.states).toEqual({ s1: 'understood', s2: 'understood' })
    expect(state.answers.map((item) => item.correct)).toEqual([false, true])
  })

  it('keeps understood when a later attempt is wrong', () => {
    recordAnswer({ ...attempt, answer: 'By hand', correct: true })
    recordAnswer({ ...attempt, answer: 'No idea', correct: false })
    expect(readingState(ALICE, FINGERPRINT).states.s1).toBe('understood')
    expect(readingState(ALICE, FINGERPRINT).answers).toHaveLength(2)
  })

  it('does not treat a truthy value as correct', () => {
    expect(() => recordAnswer({ ...attempt, answer: 'x', correct: 'true' as never })).toThrow(
      TraceInputError,
    )
    expect(readingState(ALICE, FINGERPRINT).states).toEqual({})
    expect(readingState(ALICE, FINGERPRINT).answers).toEqual([])
  })
})

describe('closing and reopening the database', () => {
  it('keeps the same marks and answers', () => {
    markSentences(ALICE, FINGERPRINT, ['s1'], 'explained')
    recordAnswer({
      readerId: ALICE,
      fingerprint: FINGERPRINT,
      questionId: 'q1',
      answer: 'By hand',
      correct: true,
      sentenceIds: ['s3'],
    })
    const before = readingState(ALICE, FINGERPRINT)
    closeDb()

    const after = readingState(ALICE, FINGERPRINT)
    expect(after).toEqual(before)
    expect(after.states).toEqual({ s1: 'explained', s3: 'understood' })
    expect(after.answers).toHaveLength(1)
  })
})

describe('two readers', () => {
  it('stay apart in marks and answers', () => {
    markSentences(ALICE, FINGERPRINT, ['s1'], 'understood')
    recordAnswer({ readerId: ALICE, fingerprint: FINGERPRINT, questionId: 'q1', answer: 'Alice said this', correct: true, sentenceIds: ['s1'] })
    expect(readingState(BOB, FINGERPRINT)).toEqual({ states: {}, answers: [] })
    expect(readingState(ALICE, FINGERPRINT).answers).toHaveLength(1)
  })

  it('stay apart between texts for one reader', () => {
    const other = 'b'.repeat(64)
    markSentences(ALICE, FINGERPRINT, ['s1'], 'understood')
  })
})
