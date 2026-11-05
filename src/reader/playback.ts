import { GEOMETRY } from './geometry'

export interface SectionLike { id: string; title: string; pointIds: readonly string[] }
export interface Place { section: number; point: number }

export function clampPlace(place: Place, sections: readonly SectionLike[]): Place {
  if (sections.length === 0) return { section: 0, point: 0 }
  const section = Math.min(Math.max(Math.trunc(place.section) || 0, 0), sections.length - 1)
  const count = sections[section].pointIds.length
  const point = count > 0 ? Math.min(Math.max(Math.trunc(place.point) || 0, 0), count - 1) : 0
  return { section, point }
}

export function globalIndex(place: Place, sections: readonly SectionLike[]): number {
  let n = 0
  for (let s = 0; s < place.section && s < sections.length; s++) n += sections[s].pointIds.length
  return n + place.point
}

export function placeFromGlobal(index: number, sections: readonly SectionLike[]): Place {
  let rest = Math.max(0, Math.trunc(index) || 0)
  for (let s = 0; s < sections.length; s++) {
    const count = sections[s].pointIds.length
    if (rest < count) return { section: s, point: rest }
    rest -= count
  }
  const last = Math.max(sections.length - 1, 0)
  return { section: last, point: Math.max((sections[last]?.pointIds.length ?? 1) - 1, 0) }
}

export function isLastPointOfSection(place: Place, sections: readonly SectionLike[]): boolean {
  const s = sections[place.section]
  return Boolean(s) && place.point >= s.pointIds.length - 1
}

export function nextPoint(place: Place, sections: readonly SectionLike[]): Place {
  const s = sections[place.section]
  if (!s) return place
  if (place.point + 1 < s.pointIds.length) return { section: place.section, point: place.point + 1 }
  return place
}

export function nextSectionPlace(place: Place, sections: readonly SectionLike[]): Place {
  if (place.section + 1 < sections.length) return { section: place.section + 1, point: 0 }
  return place
}

export function prevSectionPlace(place: Place, sections: readonly SectionLike[]): Place {
  if (place.section > 0) return { section: place.section - 1, point: 0 }
  return { section: 0, point: 0 }
}

export function previousTarget(place: Place, elapsedInSectionSec: number, sections: readonly SectionLike[]): Place {
  if (elapsedInSectionSec < GEOMETRY.prevSectionWindowSec) return prevSectionPlace(place, sections)
  return { section: place.section, point: 0 }
}

/** How long a point with no voice stays lit, at an unhurried reading pace. */
export function silentPointMs(spoken: string): number {
  return Math.max(2500, Math.round((spoken.length / 16) * 1000))
}

export type PlaybackMode = 'voiced' | 'silent'

export function modeForPoint(pointId: string, voicedIds: ReadonlySet<string>): PlaybackMode {
  return voicedIds.has(pointId) ? 'voiced' : 'silent'
}

export function onEnterPoint(pointId: string, voicedIds: ReadonlySet<string>): { mode: PlaybackMode; openDrawer: boolean } {
  const mode = modeForPoint(pointId, voicedIds)
  return { mode, openDrawer: mode === 'silent' }
}

export interface PlayerState { place: Place; playing: boolean; atSectionEnd: boolean }

export function pausePlayer(state: PlayerState): PlayerState { return { ...state, playing: false } }
export function playPlayer(state: PlayerState): PlayerState { return { ...state, playing: true, atSectionEnd: false } }
export function resumeAfter(state: PlayerState, target: Place): PlayerState {
  return { place: target, playing: state.playing, atSectionEnd: false }
}
export function endOfSection(state: PlayerState): PlayerState { return { ...state, playing: false, atSectionEnd: true } }
export function startNextSection(state: PlayerState, sections: readonly SectionLike[]): PlayerState {
  return { place: nextSectionPlace(state.place, sections), playing: true, atSectionEnd: false }
}

export interface QuestionLike { id: string; afterPointId: string }

export function questionAfter(pointId: string, questions: readonly QuestionLike[], answered: ReadonlySet<string>, qaOn: boolean): QuestionLike | null {
  if (!qaOn) return null
  return questions.find((q) => q.afterPointId === pointId && !answered.has(q.id)) ?? null
}

export function canAnswer(answered: ReadonlySet<string>, questionId: string): boolean {
  return !answered.has(questionId)
}
