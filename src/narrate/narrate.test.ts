import { mkdir, rm, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PLAN_ARTIFACT_KIND, PLAN_MODEL, PROMPT_VERSION, planArtifactKey } from '@/deepread/deepread'
import type { Plan } from '@/lib/types'
import { putArtifact, resetStoreForTests } from '@/store/store'
import { speechForPoint, SPEECH_MODEL_ID, VOICE_ID } from './narrate'
import { DEMO_FINGERPRINT } from './range'

const fingerprint = DEMO_FINGERPRINT

function makePlan(): Plan {
  const points = Array.from({ length: 15 }, (_, i) => ({
    id: `pt${i + 1}`,
    stepId: 'step-1',
    spoken: `Spoken text for point ${i + 1} here.`,
    stickingPoints: [],
    sentenceIds: ['s1'],
    quotes: [{ sentenceId: 's1', quote: 'First sentence here.' }],
    source: { kind: 'original' as const, url: null, title: null },
    figurePages: [],
    figurePart: null,
  }))
  return {
    fingerprint,
    model: PLAN_MODEL,
    promptVersion: PROMPT_VERSION,
    createdAt: '2026-01-01T00:00:00.000Z',
    title: 'Test paper',
    steps: [0,1,2,3,4].map(i=>({ id: `step-${i+1}`, kind: 'problem' as const, title: 'Problem', points: points.filter((_,j)=>Math.floor(j/3)===i) })),
    skippable: [],
    pageNotes: [], droppedPageNotes: 0,
    questions: [],
    figures: [],
    volume: { split: false, reason: null, note: null, parts: [], imagePages: [], missingImagePages: [] },
    sourcing: { externalKept: 0, downgradedToInference: 0, links: [] },
    coverage: { total: 1, covered: 1, skippable: 0, uncovered: [] },
    usage: { calls: 1, inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningTokens: 0, webSearches: 0 },
    repaired: false,
    droppedQuotes: 0,
  }
}

let workDir: string
let previousCwd: string
let previousKey: string | undefined

beforeEach(async () => {
  previousCwd = process.cwd()
  previousKey = process.env.ELEVENLABS_API_KEY
  process.env.ELEVENLABS_API_KEY = 'test-key'
  workDir = await mkdtemp(path.join(tmpdir(), 'once-narrate-'))
  process.chdir(workDir)
  resetStoreForTests()
  const text = 'First sentence here. Second sentence follows.'
  await mkdir(path.join(workDir, 'data', 'readable'), { recursive: true })
  await writeFile(
    path.join(workDir, 'data', 'readable', `${fingerprint}.json`),
    JSON.stringify({
      fingerprint,
      kind: 'pdf',
      pageCount: 1,
      fullText: text,
      pages: [{ page: 1, width: 612, height: 792, text, items: [], isScan: false }],
    }),
    'utf8',
  )
  putArtifact({
    fingerprint,
    kind: PLAN_ARTIFACT_KIND,
    key: planArtifactKey(),
    model: PLAN_MODEL,
    promptVersion: PROMPT_VERSION,
    data: Buffer.from(JSON.stringify(makePlan()), 'utf8'),
  })
})

afterEach(async () => {
  resetStoreForTests()
  process.chdir(previousCwd)
  if (previousKey === undefined) delete process.env.ELEVENLABS_API_KEY
  else process.env.ELEVENLABS_API_KEY = previousKey
  await rm(workDir, { recursive: true, force: true })
})

function fakeFetch(calls: { count: number; urls: string[] }) {
  return async (url: string, init?: RequestInit) => {
    calls.count += 1
    calls.urls.push(url)
    const body = JSON.parse(String(init?.body)) as { text: string; model_id: string }
    expect(url).toContain(`/v1/text-to-speech/${VOICE_ID}/with-timestamps`)
    expect(body.model_id).toBe(SPEECH_MODEL_ID)
    const chars = [...body.text]
    return new Response(
      JSON.stringify({
        audio_base64: Buffer.from('fake-audio').toString('base64'),
        alignment: {
          characters: chars,
          character_start_times_seconds: chars.map((_, i) => i * 0.1),
          character_end_times_seconds: chars.map((_, i) => (i + 1) * 0.1),
        },
        normalized_alignment: {
          characters: ['X'],
          character_start_times_seconds: [0],
          character_end_times_seconds: [0.1],
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }
}

describe('speechForPoint', () => {
  it('generates once, then serves repeats from cache with no new call', async () => {
    const calls = { count: 0, urls: [] as string[] }
    const fetchImpl = fakeFetch(calls) as typeof fetch

    const first = await speechForPoint({ fingerprint, pointId: 'pt1' , fetchImpl })
    expect(first.cached).toBe(false)
    expect(first.audioBase64).toBe(Buffer.from('fake-audio').toString('base64'))
    expect(first.alignment.characters.join('')).toBe(first.text)
    expect(calls.count).toBe(1)

    const second = await speechForPoint({ fingerprint, pointId: 'pt1' , fetchImpl })
    expect(second.cached).toBe(true)
    expect(second.audioBase64).toBe(first.audioBase64)
    expect(second.alignment).toEqual(first.alignment)
    expect(calls.count).toBe(1)
  })

  it('refuses a point beyond the voiced range without calling ElevenLabs', async () => {
    const calls = { count: 0, urls: [] as string[] }
    const fetchImpl = fakeFetch(calls) as typeof fetch
    await expect(
      speechForPoint({ fingerprint, pointId: 'pt13' , fetchImpl }),
    ).rejects.toMatchObject({ status: 403 })
    expect(calls.count).toBe(0)
  })

  it('reports a missing key in English without calling ElevenLabs', async () => {
    delete process.env.ELEVENLABS_API_KEY
    const calls = { count: 0, urls: [] as string[] }
    const fetchImpl = fakeFetch(calls) as typeof fetch
    await expect(
      speechForPoint({ fingerprint, pointId: 'pt2' , fetchImpl }),
    ).rejects.toMatchObject({ status: 503 })
    expect(calls.count).toBe(0)
  })
})
