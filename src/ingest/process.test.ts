import { describe, expect, it } from 'vitest'
import { estimateSeconds, remainingSeconds } from './process'

describe('the wait shown while a text is prepared', () => {
  it('grows with the length of the text', () => {
    expect(estimateSeconds(40_000)).toBeGreaterThan(estimateSeconds(3_000))
  })

  it('counts down from when processing started and never goes below zero', () => {
    const start = '2026-11-04T10:00:00.000Z'
    const total = estimateSeconds(10_000)
    expect(remainingSeconds(start, 10_000, Date.parse(start) + 60_000)).toBe(total - 60)
    expect(remainingSeconds(start, 10_000, Date.parse(start) + 86_400_000)).toBe(0)
  })

  it('says nothing before the size of the text is known', () => {
    expect(remainingSeconds('2026-11-04T10:00:00.000Z', null)).toBeNull()
    expect(remainingSeconds(null, 100)).toBeNull()
  })
})
