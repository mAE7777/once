import { describe, expect, it } from 'vitest'
import {
  canAnswer, endOfSection, globalIndex, modeForPoint, nextPoint, onEnterPoint,
  pausePlayer, placeFromGlobal, playPlayer, previousTarget, questionAfter,
  resumeAfter, startNextSection, type SectionLike,
} from './playback'

const sections: SectionLike[] = [
  { id: 'a', title: 'A', pointIds: ['p1', 'p2'] },
  { id: 'b', title: 'B', pointIds: ['p3', 'p4', 'p5'] },
  { id: 'c', title: 'C', pointIds: ['p6'] },
]

describe('section navigation', () => {
  it('maps between global and section places', () => {
    expect(placeFromGlobal(3, sections)).toEqual({ section: 1, point: 1 })
    expect(globalIndex({ section: 1, point: 1 }, sections)).toBe(3)
    expect(placeFromGlobal(99, sections)).toEqual({ section: 2, point: 0 })
  })
  it('applies the 3 second rule for previous', () => {
    expect(previousTarget({ section: 1, point: 2 }, 2.9, sections)).toEqual({ section: 0, point: 0 })
    expect(previousTarget({ section: 1, point: 2 }, 3, sections)).toEqual({ section: 1, point: 0 })
    expect(previousTarget({ section: 1, point: 2 }, 12, sections)).toEqual({ section: 1, point: 0 })
    expect(previousTarget({ section: 0, point: 1 }, 1, sections)).toEqual({ section: 0, point: 0 })
  })
  it('advances a point inside its section only', () => {
    expect(nextPoint({ section: 0, point: 0 }, sections)).toEqual({ section: 0, point: 1 })
    expect(nextPoint({ section: 0, point: 1 }, sections)).toEqual({ section: 0, point: 1 })
  })
})

describe('resume after every pause path', () => {
  const base = { place: { section: 1, point: 1 }, playing: true, atSectionEnd: false }
  it('pause then play resumes the same point', () => {
    const s = playPlayer(pausePlayer(base))
    expect(s).toEqual({ place: { section: 1, point: 1 }, playing: true, atSectionEnd: false })
  })
  it('pause then previous then play keeps playing from the target', () => {
    const paused = pausePlayer(base)
    const moved = resumeAfter({ ...paused, playing: true }, previousTarget(paused.place, 1, sections))
    expect(moved.place).toEqual({ section: 0, point: 0 })
    expect(playPlayer(moved).playing).toBe(true)
  })
  it('end of section then next starts the next section playing', () => {
    const ended = endOfSection({ place: { section: 0, point: 1 }, playing: true, atSectionEnd: false })
    expect(ended).toEqual({ place: { section: 0, point: 1 }, playing: false, atSectionEnd: true })
    expect(startNextSection(ended, sections)).toEqual({ place: { section: 1, point: 0 }, playing: true, atSectionEnd: false })
  })
})

describe('voiced range transitions', () => {
  const voiced = new Set(['p1', 'p2', 'p3'])
  it('opens the drawer by itself past the voiced range, with no sound', () => {
    expect(modeForPoint('p2', voiced)).toBe('voiced')
    expect(onEnterPoint('p4', voiced)).toEqual({ mode: 'silent', openDrawer: true })
    expect(onEnterPoint('p1', voiced)).toEqual({ mode: 'voiced', openDrawer: false })
  })
})

describe('question timing and the one-answer rule', () => {
  const questions = [{ id: 'q1', afterPointId: 'p2' }, { id: 'q2', afterPointId: 'p2' }]
  it('fires only when on, at the point, and unanswered', () => {
    expect(questionAfter('p2', questions, new Set(), true)?.id).toBe('q1')
    expect(questionAfter('p2', questions, new Set(), false)).toBeNull()
    expect(questionAfter('p1', questions, new Set(), true)).toBeNull()
    expect(questionAfter('p2', questions, new Set(['q1']), true)?.id).toBe('q2')
    expect(questionAfter('p2', questions, new Set(['q1', 'q2']), true)).toBeNull()
  })
  it('allows one answer per question', () => {
    expect(canAnswer(new Set(), 'q1')).toBe(true)
    expect(canAnswer(new Set(['q1']), 'q1')).toBe(false)
  })
})
