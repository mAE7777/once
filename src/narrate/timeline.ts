export interface CharacterAlignment {
  characters: string[]
  character_start_times_seconds: number[]
  character_end_times_seconds: number[]
}

export interface WordSpan {
  index: number
  start: number
  end: number
  text: string
}

export function wordsOf(text: string): WordSpan[] {
  const words: WordSpan[] = []
  const pattern = /\S+/g
  let match: RegExpExecArray | null
  let index = 0
  while ((match = pattern.exec(text)) !== null) {
    words.push({ index, start: match.index, end: match.index + match[0].length, text: match[0] })
    index += 1
  }
  return words
}

export function pointDurationSeconds(alignment: CharacterAlignment): number {
  const ends = alignment.character_end_times_seconds
  if (ends.length === 0) return 0
  return ends[ends.length - 1]
}

export function charIndexAtTime(alignment: CharacterAlignment, timeSec: number): number {
  const starts = alignment.character_start_times_seconds
  const ends = alignment.character_end_times_seconds
  if (starts.length === 0) return -1
  if (timeSec <= 0) return 0
  const duration = pointDurationSeconds(alignment)
  if (timeSec >= duration) return starts.length - 1
  for (let i = 0; i < starts.length; i += 1) {
    if (timeSec >= starts[i] && timeSec < ends[i]) return i
  }
  let nearest = 0
  for (let i = 0; i < starts.length; i += 1) {
    if (starts[i] <= timeSec) nearest = i
  }
  return nearest
}

export function wordAtTime(
  text: string,
  alignment: CharacterAlignment,
  timeSec: number,
): WordSpan | null {
  const words = wordsOf(text)
  if (words.length === 0) return null
  const charIndex = charIndexAtTime(alignment, timeSec)
  if (charIndex < 0) return words[0]
  for (const word of words) {
    if (charIndex >= word.start && charIndex < word.end) return word
  }
  let previous: WordSpan | null = null
  for (const word of words) {
    if (word.start > charIndex) return previous ?? word
    previous = word
  }
  return previous ?? words[words.length - 1]
}

export interface TimelinePoint {
  pointId: string
  sentenceIds: readonly string[]
  text: string
  alignment: CharacterAlignment
}

export interface TimelineEntry extends TimelinePoint {
  startSec: number
  durationSec: number
  endSec: number
}

export function buildTimeline(points: readonly TimelinePoint[]): TimelineEntry[] {
  const entries: TimelineEntry[] = []
  let cursor = 0
  for (const point of points) {
    const durationSec = pointDurationSeconds(point.alignment)
    entries.push({ ...point, startSec: cursor, durationSec, endSec: cursor + durationSec })
    cursor += durationSec
  }
  return entries
}

export interface TimelineSample {
  pointId: string
  sentenceIds: readonly string[]
  word: WordSpan | null
  pointTimeSec: number
}

export function sampleAt(entries: readonly TimelineEntry[], timeSec: number): TimelineSample | null {
  if (entries.length === 0) return null
  const clamped = Math.max(0, timeSec)
  const entry =
    entries.find((item) => clamped >= item.startSec && clamped < item.endSec) ??
    entries[entries.length - 1]
  const pointTimeSec = Math.min(Math.max(clamped - entry.startSec, 0), entry.durationSec)
  return {
    pointId: entry.pointId,
    sentenceIds: entry.sentenceIds,
    word: wordAtTime(entry.text, entry.alignment, pointTimeSec),
    pointTimeSec,
  }
}
