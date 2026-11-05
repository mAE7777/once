import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PLAN_ARTIFACT_KIND, PLAN_MODEL, PROMPT_VERSION, planArtifactKey } from '@/deepread/deepread'
import { FINGERPRINT, storeDocument, textPage } from '@/deepread/fixtures'
import type { Sentence } from '@/lib/types'
import { closeDb, putArtifact, resetStoreForTests } from '@/store/store'
import { planOver } from '@/traces/fixtures'
import { readingState } from '@/traces/traces'
import { answerQuestion, QA_INSTRUCTIONS, QA_PROMPT_VERSION } from './qa'
import { GET as getQa, POST as postQa } from '../../app/api/documents/[fingerprint]/qa/route'

const ALICE = 'reader-alice'
const BOB = 'reader-bob-1'
const BASE = `http://once.test/api/documents/${FINGERPRINT}/qa`
const KEY_POINT = 'It was done by hand, word by word'

let workDir: string
let previousCwd: string
let sentences: Sentence[]
let bodies: Record<string, unknown>[]

function modelVerdict(understood: boolean, response: string): Response { return new Response(JSON.stringify({ output_text: JSON.stringify({ response, understood }), usage: { input_tokens: 12, output_tokens: 6, total_tokens: 18 } }), { status: 200, headers: { 'Content-Type': 'application/json' } }) }
const REPLY = 'You are picturing the slow hand work well. A machine taking over the word-by-word part is what changes it, and that holds while the text is ordinary, though names and idioms still need care.'

function installFakeFetch(...queue: (() => Response)[]) {
  bodies = []
  const fake = vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    const next = queue[bodies.length - 1]
    if (!next) throw new Error(`unexpected model call ${bodies.length}`)
    return next()
  })
  vi.stubGlobal('fetch', fake)
  return fake
}

function call(url: string, options: { reader?: string; method?: string; body?: unknown } = {}): Request {
  const headers = new Headers()
  headers.set('x-reader-id', options.reader ?? ALICE)
  return new Request(url, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
}

function params() {
  return { params: Promise.resolve({ fingerprint: FINGERPRINT }) }
}

beforeEach(async () => {
  previousCwd = process.cwd()
  workDir = await mkdtemp(path.join(tmpdir(), 'once-qa-'))
  process.chdir(workDir)
  resetStoreForTests()
  process.env.META_API_KEY = 'test-key'
  bodies = []
  sentences = await storeDocument([
    textPage(1, 'People translated by hand. It took years to learn.'),
    textPage(2, 'Attention looks back at the input. It weighs each part.'),
  ])
  const plan = planOver(FINGERPRINT, sentences)
  plan.questions = [{ id: 'q1', afterPointId: 'pt1', question: 'You are translating a long letter with a dictionary, one word at a time. Why does it take so long, and what would have to change for it to speed up?', guidance: 'A strong answer works out that it was done by hand, and where that holds or breaks.', earnsSentenceIds: [sentences[0].id] }]
  putArtifact({
    fingerprint: FINGERPRINT,
    kind: PLAN_ARTIFACT_KIND,
    key: planArtifactKey(),
    model: PLAN_MODEL,
    promptVersion: PROMPT_VERSION,
    data: Buffer.from(JSON.stringify(plan)),
  })
})

afterEach(async () => {
  closeDb()
  vi.unstubAllGlobals()
  process.chdir(previousCwd)
  await rm(workDir, { recursive: true, force: true })
})

describe('answerQuestion', () => {
  it('returns a warm response and marks understood internally', async () => {
    const fetchImpl = vi.fn(async (_u: unknown, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return modelVerdict(true, REPLY) }) as unknown as typeof fetch
    const result = await answerQuestion({ fingerprint: FINGERPRINT, questionId: 'q1', answer: 'A person had to do every word themselves.', readerId: ALICE, fetchImpl })
    expect(result.response).toBe(REPLY); expect(result.understood).toBe(true); expect(result.sentenceIds).toEqual([sentences[0].id])
    expect(readingState(ALICE, FINGERPRINT).states[sentences[0].id]).toBe('understood')
  })
  it('returns the stored response on a second answer with no model call', async () => {
    let count = 0; const fetchImpl = vi.fn(async () => { count++; return modelVerdict(true, REPLY) }) as unknown as typeof fetch
    const input = { fingerprint: FINGERPRINT, questionId: 'q1', answer: 'By hand.', readerId: ALICE, fetchImpl }
    await answerQuestion(input); const second = await answerQuestion({ ...input, answer: 'Something else.' })
    expect(second.stored).toBe(true); expect(second.response).toBe(REPLY); expect(count).toBe(1)
  })
  it('rejects an empty answer before any paid call', async () => { const f = vi.fn() as unknown as typeof fetch; await expect(answerQuestion({ fingerprint: FINGERPRINT, questionId: 'q1', answer: ' ', readerId: ALICE, fetchImpl: f })).rejects.toMatchObject({ status: 400 }); expect(f).not.toHaveBeenCalled() })
  it('rejects an unknown question before any paid call', async () => { const f = vi.fn() as unknown as typeof fetch; await expect(answerQuestion({ fingerprint: FINGERPRINT, questionId: 'nope', answer: 'x', readerId: ALICE, fetchImpl: f })).rejects.toMatchObject({ status: 404 }) })
  it('instructions contain no grading words', () => { expect(QA_INSTRUCTIONS).not.toMatch(/\bright\b|\bwrong\b|\bcorrect\b|\bincorrect\b|\bclose\b/i); expect(QA_INSTRUCTIONS.toLowerCase()).not.toContain('good') })
  it('instructions invite without judging and fix the shape of the reply', () => {
    expect(QA_PROMPT_VERSION).toBe('qa-5')
    expect(QA_INSTRUCTIONS).toContain('never an assessment')
    expect(QA_INSTRUCTIONS).toContain('The first word is never yes or no')
    expect(QA_INSTRUCTIONS).toContain('you got it')
    expect(QA_INSTRUCTIONS).toContain('3 to 5 short sentences')
    expect(QA_INSTRUCTIONS).toContain('no exclamation marks')
    expect(QA_INSTRUCTIONS).toContain('no dashes')
    expect(QA_INSTRUCTIONS).toContain('never a question')
    expect(QA_INSTRUCTIONS).not.toContain('Invite them to keep going')
    expect(QA_INSTRUCTIONS).not.toContain(' — ')
  })
})
describe('qa route', () => {
  it('returns only response and keeps readers separate', async () => {
    installFakeFetch(() => modelVerdict(true, REPLY), () => modelVerdict(true, REPLY))
    const res = await postQa(call(BASE, { method: 'POST', body: { questionId: 'q1', answer: 'By hand.' } }), params())
    const body = await res.json(); expect(body.response).toBe(REPLY); expect(body.correct).toBeUndefined(); expect(body.answerKey).toBeUndefined()
    const bob = await postQa(call(BASE, { reader: BOB, method: 'POST', body: { questionId: 'q1', answer: 'By hand.' } }), params()); expect(bob.status).toBe(200)
  })
  it('has no reveal action', async () => {
    installFakeFetch(() => modelVerdict(true, REPLY))
    const res = await postQa(call(BASE, { method: 'POST', body: { questionId: 'q1', reveal: true } }), params()); expect(res.status).toBe(400)
  })
})
