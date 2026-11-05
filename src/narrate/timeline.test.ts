import { describe, expect, it } from 'vitest'
import {
  buildTimeline,
  pointDurationSeconds,
  sampleAt,
  wordAtTime,
  wordsOf,
  type CharacterAlignment,
} from './timeline'

function alignmentFor(text: string, secPerChar = 0.1): CharacterAlignment {
  return {
    characters: [...text],
    character_start_times_seconds: [...text].map((_, i) => i * secPerChar),
    character_end_times_seconds: [...text].map((_, i) => (i + 1) * secPerChar),
  }
}

describe('timeline', () => {
  it('splits words with exact offsets', () => {
    expect(wordsOf('Hello brave  world.')).toEqual([
      { index: 0, start: 0, end: 5, text: 'Hello' },
      { index: 1, start: 6, end: 11, text: 'brave' },
      { index: 2, start: 13, end: 19, text: 'world.' },
    ])
  })

  it('reports a point duration from the last character end', () => {
    expect(pointDurationSeconds(alignmentFor('abc'))).toBeCloseTo(0.3)
    expect(
      pointDurationSeconds({
        characters: [],
        character_start_times_seconds: [],
        character_end_times_seconds: [],
      }),
    ).toBe(0)
  })

  it('finds the word being said at a time', () => {
    const text = 'Alpha beta gamma.'
    const alignment = alignmentFor(text)
    expect(wordAtTime(text, alignment, 0)?.text).toBe('Alpha')
    expect(wordAtTime(text, alignment, 0.65)?.text).toBe('beta')
    expect(wordAtTime(text, alignment, 1.15)?.text).toBe('gamma.')
    expect(wordAtTime(text, alignment, 99)?.text).toBe('gamma.')
  })

  it('samples the sentence ids of the point being spoken', () => {
    const firstText = 'First point speaks.'
    const secondText = 'Second point follows here.'
    const entries = buildTimeline([
      {
        pointId: 'pt1',
        sentenceIds: ['s1', 's3'],
        text: firstText,
        alignment: alignmentFor(firstText),
      },
      {
        pointId: 'pt2',
        sentenceIds: ['s2'],
        text: secondText,
        alignment: alignmentFor(secondText),
      },
    ])

    const firstDuration = pointDurationSeconds(entries[0].alignment)
    const inFirst = sampleAt(entries, firstDuration / 2)
    expect(inFirst?.pointId).toBe('pt1')
    expect(inFirst?.sentenceIds).toEqual(['s1', 's3'])

    const inSecond = sampleAt(entries, firstDuration + 0.25)
    expect(inSecond?.pointId).toBe('pt2')
    expect(inSecond?.sentenceIds).toEqual(['s2'])
    expect(entries[1].startSec).toBeCloseTo(firstDuration)
  })
})
