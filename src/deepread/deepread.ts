import type { ArtifactLookup, Plan, PlanResult } from '@/lib/types'
import { makeReadable } from '@/readable/readable'
import { SentenceDocumentNotFoundError, makeSentences } from '@/sentences/sentences'
import { getArtifact, putArtifact, readArtifact } from '@/store/store'
import { PlanInputError, PlanStoreError, emptyUsage } from './call'
import { runEngine, type EngineStage } from './engine'
import { NonEnglishTextError, detectTextLanguage } from './language'
import { toStoredPlan } from './normalize'
import { findImagePages, splitIntoVolumes, volumeNote, type VolumeSplit } from './pages'
import { PLAN_MODEL, PROMPT_VERSION } from './prompt'

export {
  MAX_PLAN_ATTEMPTS,
  MAX_REPAIR_ATTEMPTS,
  PlanCoverageError,
  PlanInputError,
  PlanModelError,
  PlanStoreError,
  finalOutputText,
} from './call'
export { MAX_REPAIR_ROUNDS, type EngineStage } from './engine'
export { PLAN_MODEL, PROMPT_VERSION } from './prompt'
export { PLAN_OUTPUT_SCHEMA } from './schema'
export type { Plan, PlanResult } from '@/lib/types'

export const PLAN_ARTIFACT_KIND = 'plan'

export function planArtifactKey(): string { return 'plan' }

export interface MakePlanOptions {
  redo?: boolean
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  onStage?: (stage: EngineStage) => void
  now?: () => number
}

const inFlight = new Map<string, Promise<PlanResult>>()

function assertFingerprint(fingerprint: string): void {
  if (!/^[0-9a-f]{64}$/i.test(fingerprint)) {
    throw new SentenceDocumentNotFoundError()
  }
}

function lookupPlan(fingerprint: string): ArtifactLookup | null {
  return getArtifact(fingerprint, PLAN_ARTIFACT_KIND, planArtifactKey(), {
    model: PLAN_MODEL,
    promptVersion: PROMPT_VERSION,
  })
}

function readStoredPlan(lookup: ArtifactLookup): PlanResult {
  try {
    const plan = JSON.parse(readArtifact(lookup.path).toString('utf8')) as Plan
    return { plan, isCurrent: lookup.isCurrent, reused: true }
  } catch {
    throw new PlanStoreError(
      'The stored explanation plan for this text could not be read. Remove it from the store to make a new one.',
    )
  }
}

async function buildPlan(fingerprint: string, options: MakePlanOptions): Promise<PlanResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  const { sentences } = await makeSentences(fingerprint)
  if (sentences.length === 0) {
    throw new PlanInputError('This text has no sentences to explain.')
  }
  const document = await makeReadable(fingerprint, { metaFetchImpl: fetchImpl })
  const imagePages = await findImagePages(document)
  const split: VolumeSplit = splitIntoVolumes(document.pages, imagePages)

  if (detectTextLanguage(sentences) !== 'en') throw new NonEnglishTextError()
  const usage = emptyUsage()
  const result = await runEngine({
    fingerprint,
    document,
    sentences,
    split,
    usage,
    fetchImpl,
    sleep,
    onStage: options.onStage ?? (() => undefined),
    now: options.now,
    startedAt: (options.now ?? Date.now)(),
  })

  const plan = toStoredPlan({
    fingerprint,
    model: PLAN_MODEL,
    promptVersion: PROMPT_VERSION,
    createdAt: new Date().toISOString(),
    raw: result.raw,
    sentences,
    pageCount: document.pageCount,
    citations: result.citations,
    volume: {
      split: split.parts.length > 1,
      reason: split.reason,
      note: volumeNote(split, imagePages.length),
      parts: split.parts,
      imagePages,
      missingImagePages: result.missingImages,
    },
    usage,
    repaired: result.repaired,
    droppedQuotes: result.droppedQuotes,
  })
  plan.report = result.report

  putArtifact({
    fingerprint,
    kind: PLAN_ARTIFACT_KIND,
    key: planArtifactKey(),
    model: PLAN_MODEL,
    promptVersion: PROMPT_VERSION,
    data: Buffer.from(JSON.stringify(plan), 'utf8'),
  })
  return { plan, isCurrent: true, reused: false }
}

export async function makePlan(fingerprint: string, options: MakePlanOptions = {}): Promise<PlanResult> {
  assertFingerprint(fingerprint)
  const stored = lookupPlan(fingerprint)
  if (stored && (!options.redo || stored.isCurrent)) {
    return readStoredPlan(stored)
  }

  const flight = fingerprint
  const running = inFlight.get(flight)
  if (running) return running

  const job = buildPlan(fingerprint, options).finally(() => {
    inFlight.delete(flight)
  })
  inFlight.set(flight, job)
  return job
}

export interface StoredPlanView { stored: { plan: Plan; isCurrent: boolean } | null }
export async function viewStoredPlan(fingerprint: string): Promise<StoredPlanView> {
  assertFingerprint(fingerprint)
  await makeSentences(fingerprint)
  const lookup = lookupPlan(fingerprint)
  const result = lookup ? readStoredPlan(lookup) : null
  return { stored: result && { plan: result.plan, isCurrent: result.isCurrent } }
}
