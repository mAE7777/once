import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PLAN_ARTIFACT_KIND,
  PLAN_MODEL,
  PROMPT_VERSION,
  planArtifactKey,
} from '@/deepread/deepread'
import { FINGERPRINT, storeDocument, textPage } from '@/deepread/fixtures'
import type { Sentence } from '@/lib/types'
import { closeDb, putArtifact, resetStoreForTests } from '@/store/store'
import { planOver } from './fixtures'
import { recordAnswer } from './traces'
import { GET as getState } from '../../app/api/documents/[fingerprint]/traces/route'
import { POST as postMark } from '../../app/api/documents/[fingerprint]/traces/mark/route'

const ALICE = 'reader-alice'
const BOB = 'reader-bob-1'
const BASE = `http://once.test/api/documents/${FINGERPRINT}/traces`

function call(
  url: string,
  options: { reader?: string | null; method?: string; body?: unknown } = {},
): Request {
  const headers = new Headers()
  const reader = options.reader === undefined ? ALICE : options.reader
  if (reader !== null) headers.set('x-reader-id', reader)
  return new Request(url, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
}

function params(fingerprint = FINGERPRINT) {
  return { params: Promise.resolve({ fingerprint }) }
}


let workDir: string
let previousCwd: string
let sentences: Sentence[]

beforeEach(async () => {
  previousCwd = process.cwd()
  workDir = await mkdtemp(path.join(tmpdir(), 'once-traces-routes-'))
  process.chdir(workDir)
  resetStoreForTests()
  sentences = await storeDocument([
    textPage(1, 'People translated by hand. It took years to learn.'),
    textPage(2, 'Attention looks back at the input. It weighs each part.'),
  ])
})

afterEach(async () => {
  closeDb()
  vi.unstubAllGlobals()
  process.chdir(previousCwd)
  await rm(workDir, { recursive: true, force: true })
})

describe('the reader header', () => {
  const cases: [string, string | null][] = [
    ['missing', null],
    ['too short', 'abc'],
    ['holding other characters', 'reader alice/../bob'],
    ['too long', 'r'.repeat(129)],
  ]

  it.each(cases)('returns 400 on every route when it is %s', async (_name, reader) => {
    const responses = await Promise.all([getState(call(BASE, { reader }), params()), postMark(call(`${BASE}/mark`, { reader, method: 'POST', body: { sentenceIds: [sentences[0].id], state: 'explained' } }), params())])
    expect(responses.map((r) => r.status)).toEqual([400, 400])
  })
})

describe('marks', () => {
  it('stores a mark, reads it back after reopening, and never downgrades', async () => {
    const ids = [sentences[0].id]
    const first = await postMark(
      call(`${BASE}/mark`, { method: 'POST', body: { sentenceIds: ids, state: 'explained' } }),
      params(),
    )
    expect(first.status).toBe(200)

    const second = await postMark(call(`${BASE}/mark`, { method: 'POST', body: { sentenceIds: ids, state: 'skippable' } }), params())
    expect(second.status).toBe(400)

    closeDb()

    const state = await getState(call(BASE), params())
    expect(state.status).toBe(200)
    expect(state.headers.get('cache-control')).toContain('no-store')
    expect((await state.json()).states).toEqual({ [ids[0]]: 'explained' })
  })

  it('refuses to mark a sentence understood, which only a correct answer can earn', async () => {
    const ids = [sentences[0].id]
    const response = await postMark(
      call(`${BASE}/mark`, { method: 'POST', body: { sentenceIds: ids, state: 'understood' } }),
      params(),
    )
    expect(response.status).toBe(400)

    const state = await getState(call(BASE), params())
    expect((await state.json()).states).toEqual({})
  })

  it('rejects a bad state and a sentence this text does not have', async () => {
    const badState = await postMark(
      call(`${BASE}/mark`, {
        method: 'POST',
        body: { sentenceIds: [sentences[0].id], state: 'read' },
      }),
      params(),
    )
    expect(badState.status).toBe(400)

    const badSentence = await postMark(
      call(`${BASE}/mark`, {
        method: 'POST',
        body: { sentenceIds: ['ghost'], state: 'explained' },
      }),
      params(),
    )
    expect(badSentence.status).toBe(400)

    const state = await getState(call(BASE), params())
    expect((await state.json()).states).toEqual({})
  })

  it('returns 404 for an unknown text', async () => {
    const response = await getState(call(BASE), params('f'.repeat(64)))
    expect(response.status).toBe(404)
  })
})

