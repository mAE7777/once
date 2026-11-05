export const DEMO_FINGERPRINT = 'bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697'
export const VOICE_CHAR_BUDGET = 3000
export interface VoiceRangePoint { id: string; spoken: string }
export function voicedPointIds(fingerprint: string, points: readonly VoiceRangePoint[]): string[] {
  if (fingerprint === DEMO_FINGERPRINT) return points.slice(0, 8).map(p=>p.id)
  const ids: string[] = []; let used = 0
  for (const point of points) { if (ids.length > 0 && used + point.spoken.length > VOICE_CHAR_BUDGET) break; ids.push(point.id); used += point.spoken.length; if (used >= VOICE_CHAR_BUDGET) break }
  return ids
}
export function voicedSectionIds(fingerprint: string, steps: readonly {id:string; points: readonly {spoken:string; figurePart?: unknown}[]}[]): string[] {
  if (fingerprint === DEMO_FINGERPRINT) {
    // The opening, plus the first figure, so a listener hears a part of it light up.
    const firstFigure = steps.findIndex((step) => step.points.some((point) => point.figurePart))
    if (firstFigure < 0) return steps.slice(0, 4).map((s) => s.id)
    return [...new Set([0, 1, firstFigure])].filter((i) => i < steps.length).map((i) => steps[i].id)
  }
  const ids: string[] = []; let used = 0
  for (const step of steps) { const chars = step.points.reduce((a,p)=>a+p.spoken.length,0); if (ids.length > 0 && used + chars > VOICE_CHAR_BUDGET) break; ids.push(step.id); used += chars }
  return ids
}
export function isVoicedPoint(fingerprint: string, points: readonly VoiceRangePoint[], pointId: string): boolean { return voicedPointIds(fingerprint, points).includes(pointId) }
