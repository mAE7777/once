import { redactSecrets } from '@/errors/errors'
import { makeReadable } from '@/readable/readable'
import { makeSentences } from '@/sentences/sentences'
import { makePlan } from '@/deepread/deepread'
import { getArtifact, getDocument } from '@/store/store'
import { titleForDocument } from './ingest'

export type ProcessStage = 'idle' | 'reading' | 'numbering' | 'understanding' | 'researching' | 'outlining' | 'writing' | 'checking' | 'repairing' | 'done' | 'failed'
export interface ProcessState { stage: ProcessStage; error: string | null; startedAt: string | null }

const states = new Map<string, ProcessState>()
const running = new Set<string>()

export function processState(fingerprint: string): ProcessState {
  const live = states.get(fingerprint)
  if (live) return live
  return getArtifact(fingerprint, 'plan', 'plan') ? { stage: 'done', error: null, startedAt: null } : { stage: 'idle', error: null, startedAt: null }
}
/** A rough wait from what real runs took, shown to the reader while a text is prepared. Never a promise. */
export function estimateSeconds(charCount: number): number {
  return Math.round(360 + charCount * 0.02)
}

/** Seconds left for a running text, or null before its size is known or once it is no longer running. */
export function remainingSeconds(startedAt: string | null, charCount: number | null, now: number = Date.now()): number | null {
  if (!startedAt || charCount === null) return null
  return Math.max(0, estimateSeconds(charCount) - Math.round((now - Date.parse(startedAt)) / 1000))
}

export function isProcessed(fingerprint: string): boolean {
  return processState(fingerprint).stage === 'done'
}

export function startProcessing(fingerprint: string): ProcessState {
  const current = processState(fingerprint)
  if (running.has(fingerprint) || current.stage === 'done') return current
  const state: ProcessState = { stage: 'reading', error: null, startedAt: new Date().toISOString() }
  states.set(fingerprint, state)
  running.add(fingerprint)
  void (async () => {
    try {
      states.set(fingerprint, { ...state, stage: 'reading' })
      await makeReadable(fingerprint)
      states.set(fingerprint, { ...state, stage: 'numbering' })
      await makeSentences(fingerprint)
      await makePlan(fingerprint, { onStage: (stage) => states.set(fingerprint, { ...state, stage }) })
      states.set(fingerprint, { ...state, stage: 'done' })
    } catch (error) {
      const message = redactSecrets(error instanceof Error ? error.message : 'Processing failed.')
      console.error(`Processing ${fingerprint} failed: ${message}`)
      states.set(fingerprint, { ...state, stage: 'failed', error: message })
    } finally { running.delete(fingerprint) }
  })()
  return state
}

export async function libraryEntry(fingerprint: string) {
  const doc = getDocument(fingerprint)
  if (!doc) return null
  let title = doc.filename
  try { const { readFile } = await import('node:fs/promises'); const raw = await readFile(`data/readable/${fingerprint}.json`, 'utf8'); const readable = JSON.parse(raw) as { fullText?: string }; if (readable.fullText) title = titleForDocument(doc.filename, readable.fullText, doc.sourceUrl) } catch { /* no readable text yet */ }
  const state = processState(fingerprint)
  return { fingerprint, title, kind: doc.kind, processed: state.stage === 'done', processing: { stage: state.stage, error: state.error } }
}
