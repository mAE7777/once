import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toErrorResponse } from '@/errors/errors'
import { MetaApiError } from '@/lib/meta'
import type { Sentence } from '@/lib/types'
import { ReadableNotBuiltError, SentenceDocumentNotFoundError } from '@/sentences/sentences'
import { closeDb, getArtifact, listArtifacts, putArtifact, resetStoreForTests } from '@/store/store'
import { GET, POST } from '../../app/api/documents/[fingerprint]/plan/route'
import {
  MAX_PLAN_ATTEMPTS,
  MAX_REPAIR_ATTEMPTS,
  PLAN_MODEL,
  PROMPT_VERSION,
  PlanCoverageError,
  PlanInputError,
  PlanModelError,
  makePlan,
  planArtifactKey,
} from './deepread'
import {
  FINGERPRINT,
  errorResponse,
  engineFetch,
  fakeFetch,
  fifteenPages,
  fullRawPlan,
  planResponse,
  rawPoint,
  sseResponse,
  storeDocument,
  streamBody,
  textPage,
  UNDERSTANDING,
} from './fixtures'
import { PLAN_OUTPUT_SCHEMA, validateAgainstSchema, type RawPlan, type RawRepair } from './schema'

let workDir: string
let previousCwd: string
const originalKey = process.env.META_API_KEY
const originalModelKey = process.env.MODEL_API_KEY
const noWait = async () => undefined

beforeEach(async () => {
  previousCwd = process.cwd()
  workDir = await mkdtemp(path.join(tmpdir(), 'once-deepread-'))
  process.chdir(workDir)
  resetStoreForTests()
  process.env.META_API_KEY = 'test-key'
})

afterEach(async () => {
  closeDb()
  process.chdir(previousCwd)
  await rm(workDir, { recursive: true, force: true })
  if (originalKey === undefined) delete process.env.META_API_KEY
  else process.env.META_API_KEY = originalKey
  if (originalModelKey === undefined) delete process.env.MODEL_API_KEY
  else process.env.MODEL_API_KEY = originalModelKey
  vi.unstubAllGlobals()
})

function userContent(body: Record<string, unknown>): Record<string, unknown>[] {
  const input = body.input as { role: string; content: Record<string, unknown>[] }[]
  return input[0].content
}

function requestText(body: Record<string, unknown>): string {
  return userContent(body)
    .filter((part) => part.type === 'input_text')
    .map((part) => part.text)
    .join('\n')
}

// Understand, research, outline, one writer per section, and one listen.
const CLEAN_RUN_CALLS = 3 + 5 + 1

describe('makePlan on a 15-page paper', () => {
  it('parses against the schema, names sources for every point and accounts for every sentence', async () => {
    const sentences = await storeDocument(fifteenPages())
    const raw = fullRawPlan(sentences)
    expect(validateAgainstSchema(raw, PLAN_OUTPUT_SCHEMA)).toEqual([])
    const fake = engineFetch(raw)

    const { plan, isCurrent, reused } = await makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl })

    expect(isCurrent).toBe(true)
    expect(reused).toBe(false)
    expect(fake.callCount()).toBe(CLEAN_RUN_CALLS)

    const points = plan.steps.flatMap((step) => step.points)
    expect(points.length).toBeGreaterThan(0)
    for (const point of points) {
      expect(point.sentenceIds.length).toBeGreaterThan(0)
      expect(point.quotes.map((quote) => quote.sentenceId)).toEqual(point.sentenceIds)
    }

    const covered = new Set(points.flatMap((point) => point.sentenceIds))
    const skipped = new Map(plan.skippable.map((entry) => [entry.sentenceId, entry.reason]))
    for (const sentence of sentences) {
      expect(covered.has(sentence.id) || Boolean(skipped.get(sentence.id))).toBe(true)
    }
    expect(plan.coverage).toEqual({
      total: sentences.length,
      covered: covered.size,
      skippable: skipped.size,
      uncovered: [],
    })
    expect(plan.repaired).toBe(false)
  })

  it('stores what the later steps need, in the shapes they read', async () => {
    const sentences = await storeDocument(fifteenPages())
    const { plan } = await makePlan(FINGERPRINT, {
      fetchImpl: engineFetch(fullRawPlan(sentences)).fetchImpl,
    })

    expect(plan.model).toBe(PLAN_MODEL)
    expect(plan.promptVersion).toBe(PROMPT_VERSION)
    expect(plan.steps.map((step) => step.kind)).toEqual([
      'context',
      'problem',
      'attempts',
      'answer',
      'applications',
    ])

    const point = plan.steps[0].points[0]
    expect(point.id).toBe('pt1')
    expect(point.stepId).toBe('st1')
    expect(point.spoken).toBe('People were doing this by hand. Attention means looking back.')
    expect(point.stickingPoints).toEqual([
      { offset: 'People were doing this by hand. '.length, reason: 'New word.' },
    ])
    expect(point.spoken.slice(point.stickingPoints[0].offset)).toBe('Attention means looking back.')
    expect(point.quotes[0]).toEqual({ sentenceId: sentences[0].id, quote: sentences[0].text })
    expect(plan.pageNotes.length).toBeGreaterThan(0)

    const question = plan.questions[0]
    expect(question).toMatchObject({ id: 'q1', afterPointId: 'pt1' })
    expect(question.earnsSentenceIds).toEqual([sentences[0].id])

    expect(plan.figures[0]).toMatchObject({ id: 'fig1', page: 2, label: 'Figure 1' })
    expect(plan.volume.split).toBe(false)
    expect(plan.volume.note).toBeNull()
  })

  
  it('normalises skippable ranges into one entry per sentence', async () => {
    const sentences = await storeDocument(fifteenPages())
    const { plan } = await makePlan(FINGERPRINT, {
      fetchImpl: engineFetch(fullRawPlan(sentences)).fetchImpl,
    })
    const lastPage = sentences.filter((sentence) => sentence.page === 15)
    expect(lastPage.length).toBeGreaterThan(1)
    expect(plan.skippable).toEqual(
      lastPage.map((sentence) => ({ sentenceId: sentence.id, reason: 'Reference list.' })),
    )
  })

  it('leaves out of skippable any sentence a point explains', async () => {
    const sentences = await storeDocument(fifteenPages())
    const raw = fullRawPlan(sentences)
    raw.skippable[0].fromSentenceId = sentences[0].id
    const { plan } = await makePlan(FINGERPRINT, { fetchImpl: engineFetch(raw).fetchImpl })
    const explained = new Set(plan.steps.flatMap((step) => step.points.flatMap((p) => p.sentenceIds)))
    expect(plan.skippable.length).toBeGreaterThan(0)
    expect(plan.skippable.filter((entry) => explained.has(entry.sentenceId))).toEqual([])
  })

  it('records token usage across the calls it made', async () => {
    const sentences = await storeDocument(fifteenPages())
    const { plan } = await makePlan(FINGERPRINT, {
      fetchImpl: engineFetch(fullRawPlan(sentences), { results: [{ url: 'https://a.example', title: 'A' }] }).fetchImpl,
    })
    expect(plan.usage).toEqual({
      calls: CLEAN_RUN_CALLS,
      inputTokens: 1000 * CLEAN_RUN_CALLS,
      cachedInputTokens: 100 * CLEAN_RUN_CALLS,
      outputTokens: 500 * CLEAN_RUN_CALLS,
      reasoningTokens: 200 * CLEAN_RUN_CALLS,
      webSearches: 1,
    })
  })
})

describe('the request', () => {
  it('reads closely at high effort with a generous budget and constrained output, and searches only in research', async () => {
    const sentences = await storeDocument(fifteenPages())
    const fake = engineFetch(fullRawPlan(sentences))

    await makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl })

    const body = fake.named('once_understand')[0]
    expect(body.model).toBe('muse-spark-1.3')
    expect(body.stream).toBe(true)
    expect(body.store).toBe(false)
    expect((body.reasoning as { effort: string }).effort).toBe('high')
    expect(body.max_output_tokens).toBeGreaterThanOrEqual(65536)
    expect(body.max_output_tokens).toBeLessThanOrEqual(131072)
    expect(body.tools).toBeUndefined()
    expect(fake.named('once_research')[0].tools).toEqual([{ type: 'web_search' }])
    expect(fake.bodies.filter((entry) => entry.tools).map((entry) => (entry.text as { format: { name: string } }).format.name)).toEqual(['once_research'])
  })

  it('sends every numbered sentence exactly, as a JSON string', async () => {
    const sentences = await storeDocument([
      textPage(1, 'A line that\nwraps over two lines. A "quoted" word here.'),
      textPage(2, 'Another page closes it. And the end.'),
    ])
    const fake = engineFetch(fullRawPlan(sentences))

    await makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl })

    const text = requestText(fake.named('once_understand')[0])
    for (const sentence of sentences) {
      expect(text).toContain(`${sentence.id} ${JSON.stringify(sentence.text)}`)
    }
    expect(text).toContain('[page 2]')
    expect(text).toContain('wraps over two lines')
  })

  
  
  it('sends page images only in the user message, labeled with their page', async () => {
    const pageDir = path.join(process.cwd(), 'data', 'pages', FINGERPRINT)
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(pageDir, { recursive: true })
    await writeFile(path.join(pageDir, 'p2.png'), Buffer.from([1, 2, 3]))
    const sentences = await storeDocument([
      textPage(1, 'First page has words here. It has more words too.'),
      textPage(2, 'Second page has a picture. It is worth a look.', {
        image: `data/pages/${FINGERPRINT}/p2.png`,
      }),
    ])
    const fake = engineFetch(fullRawPlan(sentences))

    const { plan } = await makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl })

    const body = fake.bodies[0]
    const input = body.input as { role: string }[]
    expect(input.map((message) => message.role)).toEqual(['user'])
    expect(String(body.instructions)).not.toContain('data:image')

    const content = userContent(body)
    const images = content.filter((part) => part.type === 'input_image')
    expect(images).toEqual([{ type: 'input_image', image_url: 'data:image/png;base64,AQID' }])
    const position = content.findIndex((part) => part.type === 'input_image')
    expect(content[position - 1].text).toBe('Image of page 2:')
    expect(plan.volume.imagePages).toEqual([2])
    expect(plan.volume.missingImagePages).toEqual([])
  })
})


describe('reuse', () => {
  it('makes no network call for a second request of the same content', async () => {
    const sentences = await storeDocument(fifteenPages())
    const fake = engineFetch(fullRawPlan(sentences))

    const first = await makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl })
    expect(fake.callCount()).toBe(CLEAN_RUN_CALLS)

    const second = await makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl })
    expect(fake.callCount()).toBe(CLEAN_RUN_CALLS)
    expect(second.reused).toBe(true)
    expect(second.isCurrent).toBe(true)
    expect(second.plan).toEqual(first.plan)
  })

  it('needs no key to return a stored plan', async () => {
    const sentences = await storeDocument(fifteenPages())
    await makePlan(FINGERPRINT, { fetchImpl: engineFetch(fullRawPlan(sentences)).fetchImpl })
    delete process.env.META_API_KEY
    delete process.env.MODEL_API_KEY
    const none = fakeFetch()
    const { reused } = await makePlan(FINGERPRINT, { fetchImpl: none.fetchImpl })
    expect(reused).toBe(true)
    expect(none.callCount()).toBe(0)
  })

  it('stores under its key, labeled with model and prompt version', async () => {
    const sentences = await storeDocument(fifteenPages())
    await makePlan(FINGERPRINT, { fetchImpl: engineFetch(fullRawPlan(sentences)).fetchImpl })

    const [artifact] = listArtifacts(FINGERPRINT, 'plan')
    expect(artifact.key).toBe(planArtifactKey())
    expect(artifact.model).toBe(PLAN_MODEL)
    expect(artifact.promptVersion).toBe(PROMPT_VERSION)
  })

  function storeOlderPlan(sentences: Sentence[], marker: string) {
    putArtifact({
      fingerprint: FINGERPRINT,
      kind: 'plan',
      key: planArtifactKey(),
      model: PLAN_MODEL,
      promptVersion: 'plan-0',
      data: Buffer.from(JSON.stringify({ fingerprint: FINGERPRINT, title: marker, sentences: sentences.length })),
    })
  }

  it('returns a plan from an older prompt labeled not current, without calling the model', async () => {
    const sentences = await storeDocument(fifteenPages())
    storeOlderPlan(sentences, 'older plan')
    const none = fakeFetch()

    const result = await makePlan(FINGERPRINT, { fetchImpl: none.fetchImpl })

    expect(none.callCount()).toBe(0)
    expect(result.isCurrent).toBe(false)
    expect(result.reused).toBe(true)
    expect(result.plan.title).toBe('older plan')
  })

  it('replaces an older plan on an explicit redo, then serves the new one', async () => {
    const sentences = await storeDocument(fifteenPages())
    storeOlderPlan(sentences, 'older plan')
    const fake = engineFetch(fullRawPlan(sentences))

    const redone = await makePlan(FINGERPRINT, { redo: true, fetchImpl: fake.fetchImpl })
    expect(fake.callCount()).toBe(CLEAN_RUN_CALLS)
    expect(redone.isCurrent).toBe(true)
    expect(redone.plan.title).toBe('A plain title')

    const after = await makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl })
    expect(fake.callCount()).toBe(CLEAN_RUN_CALLS)
    expect(after.isCurrent).toBe(true)
    expect(after.plan.title).toBe('A plain title')
    expect(getArtifact(FINGERPRINT, 'plan', planArtifactKey(), { promptVersion: PROMPT_VERSION })?.isCurrent).toBe(true)
  })

  it('does not pay again when a redo is asked of a plan that is already current', async () => {
    const sentences = await storeDocument(fifteenPages())
    const fake = engineFetch(fullRawPlan(sentences))
    await makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl })
    const result = await makePlan(FINGERPRINT, { redo: true, fetchImpl: fake.fetchImpl })
    expect(fake.callCount()).toBe(CLEAN_RUN_CALLS)
    expect(result.reused).toBe(true)
  })

  it('makes one call when the same plan is requested twice at once', async () => {
    const sentences = await storeDocument(fifteenPages())
    const fake = engineFetch(fullRawPlan(sentences))
    const [first, second] = await Promise.all([
      makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl }),
      makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl }),
    ])
    expect(fake.callCount()).toBe(CLEAN_RUN_CALLS)
    expect(second.plan).toEqual(first.plan)
  })
})

describe('source labels', () => {
  async function planWithSource(source: { kind: 'external'; url: string; title: string }, options: Parameters<typeof planResponse>[1]) {
    const sentences = await storeDocument(fifteenPages())
    const raw = fullRawPlan(sentences)
    raw.steps[0].points[0].source = source
    const { plan } = await makePlan(FINGERPRINT, { fetchImpl: engineFetch(raw, options).fetchImpl })
    return plan
  }

  it('keeps an external link that appears in the search results', async () => {
    const plan = await planWithSource(
      { kind: 'external', url: 'https://real.example/page', title: 'Model title' },
      { results: [{ url: 'https://real.example/page', title: 'Page title' }] },
    )
    expect(plan.steps[0].points[0].source).toEqual({
      kind: 'external',
      url: 'https://real.example/page',
      title: 'Page title',
    })
    expect(plan.sourcing).toEqual({
      externalKept: 1,
      downgradedToInference: 0,
      links: [{ url: 'https://real.example/page', title: 'Page title' }],
    })
  })

  it('keeps an external link that appears in the annotations', async () => {
    const plan = await planWithSource(
      { kind: 'external', url: 'https://cited.example/page', title: 'T' },
      { annotations: [{ url: 'https://cited.example/page', title: 'Cited' }] },
    )
    expect(plan.steps[0].points[0].source.kind).toBe('external')
  })

  it('downgrades a link the response never retrieved to inference', async () => {
    const plan = await planWithSource(
      { kind: 'external', url: 'https://made-up.example/page', title: 'Invented' },
      { results: [{ url: 'https://real.example/page', title: 'Page title' }] },
    )
    expect(plan.steps[0].points[0].source).toEqual({ kind: 'inference', url: null, title: null })
    expect(plan.sourcing.downgradedToInference).toBe(1)
    expect(plan.sourcing.links).toEqual([])
    expect(JSON.stringify(plan)).not.toContain('made-up.example')
  })

  it('downgrades when there was no search at all, and when the address is not a URL', async () => {
    const none = await planWithSource({ kind: 'external', url: 'https://x.example', title: 'X' }, {})
    expect(none.steps[0].points[0].source.kind).toBe('inference')
  })

  it('does not accept a page the model only says it opened', async () => {
    const plan = await planWithSource(
      { kind: 'external', url: 'https://opened.example/page', title: 'Opened' },
      { results: [{ url: 'https://real.example/page', title: 'Real' }] },
    )
    expect(plan.steps[0].points[0].source.kind).toBe('inference')
  })

  it('stores an address without the trailing spaces a search result came with', async () => {
    const plan = await planWithSource(
      { kind: 'external', url: 'https://telnyx.example/learn', title: 'T' },
      { results: [{ url: 'https://telnyx.example/learn  ', title: 'Learn' }] },
    )
    expect(plan.steps[0].points[0].source.url).toBe('https://telnyx.example/learn')
    expect(plan.sourcing.links).toEqual([{ url: 'https://telnyx.example/learn', title: 'Learn' }])
  })

  it('stores the retrieved address when the model tidied it', async () => {
    const plan = await planWithSource(
      { kind: 'external', url: 'https://arxiv.org/abs/1706.03762/', title: 'T' },
      { results: [{ url: 'https://arxiv.org/abs/1706.03762?embedable=true', title: 'Paper' }] },
    )
    expect(plan.steps[0].points[0].source.url).toBe('https://arxiv.org/abs/1706.03762?embedable=true')
  })

  
  it('clears stray addresses from original and inference sources', async () => {
    const sentences = await storeDocument(fifteenPages())
    const raw = fullRawPlan(sentences)
    raw.steps[0].points[0].source = { kind: 'original', url: 'https://stray.example', title: 'Stray' }
    const { plan } = await makePlan(FINGERPRINT, { fetchImpl: engineFetch(raw).fetchImpl })
    expect(plan.steps[0].points[0].source).toEqual({ kind: 'original', url: null, title: null })
  })
})

describe('failures from the model', () => {
  const understanding = planResponse(UNDERSTANDING)

  it('treats status incomplete as a failure and retries, keeping no partial plan', async () => {
    const sentences = await storeDocument(fifteenPages())
    const sleep = vi.fn(noWait)
    const fake = engineFetch(fullRawPlan(sentences), {
      queue: { once_understand: [planResponse(UNDERSTANDING, { status: 'incomplete' })] },
    })
    const { plan } = await makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl, sleep })
    expect(fake.named('once_understand')).toHaveLength(2)
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(plan.usage.calls).toBe(CLEAN_RUN_CALLS + 1)
  })

  it('stops after a bounded number of incomplete responses and saves nothing', async () => {
    const sentences = await storeDocument(fifteenPages())
    const incomplete = planResponse(UNDERSTANDING, { status: 'incomplete' })
    const fake = engineFetch(fullRawPlan(sentences), {
      queue: { once_understand: Array.from({ length: MAX_PLAN_ATTEMPTS + 2 }, () => incomplete) },
    })
    const error = await makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl, sleep: noWait }).catch((err) => err)
    expect(error).toBeInstanceOf(PlanModelError)
    expect(error.message).toContain('max_output_tokens')
    expect(fake.callCount()).toBe(MAX_PLAN_ATTEMPTS)
    expect(listArtifacts(FINGERPRINT, 'plan')).toEqual([])
    expect(toErrorResponse(error).status).toBe(502)
  })

  it('retries output that is not JSON, then fails honestly', async () => {
    const sentences = await storeDocument(fifteenPages())
    const broken = () => sseResponse(streamBody('{"title": "cut off'))
    const fake = engineFetch(fullRawPlan(sentences), {
      queue: { once_understand: Array.from({ length: MAX_PLAN_ATTEMPTS }, () => broken) },
    })
    const error = await makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl, sleep: noWait }).catch((err) => err)
    expect(error).toBeInstanceOf(PlanModelError)
    expect(error.message).toContain('not valid JSON')
    expect(fake.callCount()).toBe(MAX_PLAN_ATTEMPTS)
  })

  it('retries output that breaks the schema and uses a later good answer', async () => {
    const sentences = await storeDocument(fifteenPages())
    const fake = engineFetch(fullRawPlan(sentences), {
      queue: { once_understand: [planResponse({ title: 'no notes' }), understanding] },
    })
    const { plan } = await makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl, sleep: noWait })
    expect(fake.named('once_understand')).toHaveLength(2)
    expect(plan.steps).toHaveLength(5)
  })

  it('retries an outline whose sections run out of problem order', async () => {
    const sentences = await storeDocument(fifteenPages())
    const raw = fullRawPlan(sentences)
    const reversed = structuredClone(raw)
    reversed.steps.reverse()
    const outOfOrder = { title: 't', sharedFacts: [], skippable: [], sections: reversed.steps.map((step) => ({ kind: step.kind, title: step.title, startsFrom: 'a', leavesBroken: 'b', situation: 'c', analogies: [], quantities: [], boundaries: [], ideasGrownHere: [], sentenceRanges: [] })) }
    const fake = engineFetch(raw, { queue: { once_outline: [planResponse(outOfOrder)] } })
    await makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl, sleep: noWait })
    expect(fake.named('once_outline')).toHaveLength(2)
  })

  it('reads the answer, not the commentary, when the model searched first', async () => {
    const sentences = await storeDocument(fifteenPages())
    const fake = engineFetch(fullRawPlan(sentences), { results: [{ url: 'https://a.example', title: 'A' }] })
    const { plan } = await makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl })
    expect(fake.named('once_research')).toHaveLength(1)
    expect(plan.title).toBe('A plain title')
  })

  it('retries a passing upstream failure and a dropped stream', async () => {
    const sentences = await storeDocument(fifteenPages())
    const fake = engineFetch(fullRawPlan(sentences), {
      queue: {
        once_understand: [
          () => errorResponse(500, 'Model output parsing failure'),
          () => sseResponse(`event: response.created\ndata: {"type":"response.created"}\n\n`),
        ],
      },
    })
    const { plan } = await makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl, sleep: noWait })
    expect(fake.named('once_understand')).toHaveLength(3)
    expect(plan.usage.calls).toBe(CLEAN_RUN_CALLS)
  })

  it('throws the upstream status once retries run out', async () => {
    await storeDocument(fifteenPages())
    const fake = fakeFetch(...Array.from({ length: MAX_PLAN_ATTEMPTS }, () => () => errorResponse(503, 'overloaded')))
    const error = await makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl, sleep: noWait }).catch((err) => err)
    expect(error).toBeInstanceOf(MetaApiError)
    expect(error.status).toBe(503)
    expect(fake.callCount()).toBe(MAX_PLAN_ATTEMPTS)
    const response = toErrorResponse(error)
    expect(response.status).toBe(502)
    expect(response.body.error).toContain('503')
    expect(response.body.error).toContain('overloaded')
  })

  it('does not retry a request the API will always reject', async () => {
    await storeDocument(fifteenPages())
    const fake = fakeFetch(() => errorResponse(400, 'schema not allowed'))
    const error = await makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl, sleep: noWait }).catch((err) => err)
    expect(error).toBeInstanceOf(MetaApiError)
    expect(error.status).toBe(400)
    expect(fake.callCount()).toBe(1)
  })

  it('reports a missing key without calling the network', async () => {
    await storeDocument(fifteenPages())
    delete process.env.META_API_KEY
    delete process.env.MODEL_API_KEY
    const none = fakeFetch()
    const error = await makePlan(FINGERPRINT, { fetchImpl: none.fetchImpl, sleep: noWait }).catch((err) => err)
    expect(error).toBeInstanceOf(MetaApiError)
    expect(toErrorResponse(error).status).toBe(503)
    expect(toErrorResponse(error).body.error).toContain('META_API_KEY')
    expect(none.callCount()).toBe(0)
  })

  it('never lets a key reach the reader through an upstream message', async () => {
    await storeDocument(fifteenPages())
    const fake = fakeFetch(() => errorResponse(400, 'bad key test-key given'))
    const error = await makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl, sleep: noWait }).catch((err) => err)
    expect(toErrorResponse(error).body.error).not.toContain('test-key')
  })

  it('keeps going without research when research fails, and says so', async () => {
    const sentences = await storeDocument(fifteenPages())
    const failing = () => errorResponse(503, 'search down')
    const fake = engineFetch(fullRawPlan(sentences), {
      queue: { once_research: Array.from({ length: MAX_PLAN_ATTEMPTS }, () => failing) },
    })
    const { plan } = await makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl, sleep: noWait })
    expect(plan.report?.notes.join(' ')).toContain('research could not be completed')
    expect(plan.steps).toHaveLength(5)
  })
})

describe('coverage repair', () => {
  function withGap(sentences: Sentence[]): { raw: RawPlan; missing: Sentence } {
    const raw = fullRawPlan(sentences)
    const point = raw.steps[1].points[0]
    const dropped = point.quotes.shift() as { sentenceId: string }
    return {
      raw,
      missing: sentences.find((sentence) => sentence.id === dropped.sentenceId) as Sentence,
    }
  }
  const repairOf = (fix: Partial<RawRepair>) => ({
    queue: { once_plan_repair: [planResponse({ corrections: [], addedQuotes: [], addedPoints: [], addedSkippable: [], ...fix })] },
  })

  it('asks once about only the uncovered sentences and adds the answer to the plan', async () => {
    const sentences = await storeDocument(fifteenPages())
    const { raw, missing } = withGap(sentences)
    const fake = engineFetch(raw, repairOf({ addedPoints: [{ stepId: 'st2', point: rawPoint([missing]) }] }))

    const { plan } = await makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl })

    expect(fake.named('once_plan_repair')).toHaveLength(1)
    expect(plan.repaired).toBe(true)
    expect(plan.coverage.uncovered).toEqual([])
    expect(plan.steps[1].points.flatMap((point) => point.sentenceIds)).toContain(missing.id)

    const repairRequest = fake.named('once_plan_repair')[0]
    expect(repairRequest.tools).toBeUndefined()
    const task = userContent(repairRequest).at(-1)?.text as string
    expect(task).toContain(`${missing.id} ${JSON.stringify(missing.text)}`)
    expect(task).toContain('st2 (problem)')
    expect(task).not.toContain(JSON.stringify(sentences[0].text))
  })

  it('gives the writer of the section a sentence the outline forgot', async () => {
    const sentences = await storeDocument(fifteenPages())
    const { raw, missing } = withGap(sentences)
    const fake = engineFetch(raw, repairOf({ addedSkippable: [{ fromSentenceId: missing.id, toSentenceId: missing.id, reason: 'x' }] }))
    await makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl })
    const texts = fake.named('once_section').map((body) => requestText(body))
    expect(texts.some((text) => text.includes(JSON.stringify(missing.text)))).toBe(true)
  })

  it('can attach an uncovered sentence to a point that already explains it', async () => {
    const sentences = await storeDocument(fifteenPages())
    const { raw, missing } = withGap(sentences)
    const pointsBefore = raw.steps.flatMap((step) => step.points).length
    const fake = engineFetch(raw, repairOf({ addedQuotes: [{ location: 'pt2', sentenceId: missing.id, quote: missing.text }] }))
    const { plan } = await makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl })
    expect(plan.steps.flatMap((step) => step.points)).toHaveLength(pointsBefore)
    expect(plan.steps[1].points[0].quotes).toContainEqual({ sentenceId: missing.id, quote: missing.text })
    expect(plan.coverage.uncovered).toEqual([])
  })

  it('does not let an attached quote cover a sentence it does not match, and records the gap', async () => {
    const sentences = await storeDocument(fifteenPages())
    const { raw, missing } = withGap(sentences)
    const fake = engineFetch(raw, repairOf({ addedQuotes: [{ location: 'pt2', sentenceId: missing.id, quote: 'Something else entirely.' }] }))
    const { plan } = await makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl })
    expect(plan.coverage.uncovered).toEqual([missing.id])
    expect(plan.droppedQuotes).toBe(1)
    expect(plan.report?.notes.join(' ')).toContain(missing.id)
  })

  it('can mark the gap skippable, normalised like the rest', async () => {
    const sentences = await storeDocument(fifteenPages())
    const { raw, missing } = withGap(sentences)
    const fake = engineFetch(raw, repairOf({ addedSkippable: [{ fromSentenceId: missing.id, toSentenceId: missing.id, reason: 'A repeated example.' }] }))
    const { plan } = await makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl })
    expect(plan.skippable).toContainEqual({ sentenceId: missing.id, reason: 'A repeated example.' })
    expect(plan.coverage.uncovered).toEqual([])
  })

  it('keeps the plan and records a small gap the repair could not close, filling nothing itself', async () => {
    const sentences = await storeDocument(fifteenPages())
    const { raw, missing } = withGap(sentences)
    const fake = engineFetch(raw)
    const { plan } = await makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl })
    expect(plan.coverage.uncovered).toEqual([missing.id])
    expect(plan.report?.notes.join(' ')).toContain(missing.id)
    expect(listArtifacts(FINGERPRINT, 'plan')).toHaveLength(1)
  })

  it('fails honestly when a large share of the text stays unexplained, saving nothing', async () => {
    const sentences = await storeDocument(fifteenPages())
    const raw = fullRawPlan(sentences)
    for (const step of raw.steps.slice(1)) step.points[0].quotes = step.points[0].quotes.slice(0, 1)
    const fake = engineFetch(raw)
    const error = await makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl }).catch((err) => err)
    expect(error).toBeInstanceOf(PlanCoverageError)
    expect(listArtifacts(FINGERPRINT, 'plan')).toEqual([])
    expect(toErrorResponse(error).status).toBe(502)
  })

  it('asks the model about a quote that matches no sentence, and takes its corrected quote', async () => {
    const sentences = await storeDocument(fifteenPages())
    const raw = fullRawPlan(sentences)
    const target = raw.steps[0].points[0].quotes[0]
    const real = target.sentenceId
    raw.steps[0].points[0].quotes[0] = { sentenceId: 's9999', quote: 'A reworded version of it.' }
    const fake = engineFetch(raw, repairOf({ corrections: [{ location: 'pt1', wrongId: 's9999', rightId: real, quote: target.quote }] }))
    const { plan } = await makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl })
    expect(plan.repaired).toBe(true)
    expect(plan.droppedQuotes).toBe(0)
    expect(plan.steps[0].points[0].quotes).toContainEqual({ sentenceId: real, quote: target.quote })
    expect(plan.steps[0].points[0].sentenceIds).not.toContain('s9999')
    const task = userContent(fake.named('once_plan_repair')[0]).at(-1)?.text as string
    expect(task).toContain('pt1 cites s9999 with the quote "A reworded version of it."')
  })

  it('does not count a sentence as covered by a quote that does not match it', async () => {
    const sentences = await storeDocument(fifteenPages())
    const raw = fullRawPlan(sentences)
    const quote = raw.steps[0].points[0].quotes[0]
    const original = quote.quote
    // Seen in a real read: the model dropped a word from the middle of a quote.
    quote.quote = original.replace(' claim ', ' ')
    const fake = engineFetch(raw, repairOf({ corrections: [{ location: 'pt1', wrongId: quote.sentenceId, rightId: quote.sentenceId, quote: original }] }))
    const { plan } = await makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl })
    expect(fake.named('once_plan_repair')).toHaveLength(1)
    expect(plan.steps[0].points[0].quotes[0]).toEqual({ sentenceId: quote.sentenceId, quote: original })
  })

  it('files a verbatim quote under the right sentence without another call', async () => {
    const sentences = await storeDocument(fifteenPages())
    const raw = fullRawPlan(sentences)
    const quotes = raw.steps[0].points[0].quotes
    // Seen in a real read: a run of quotes carried the id of the sentence before.
    raw.steps[0].points[0].quotes = quotes.map((entry, index) =>
      index === 0 ? entry : { sentenceId: quotes[index - 1].sentenceId, quote: entry.quote },
    )
    raw.steps[1].points.push(rawPoint(sentences.slice(0, 1)))
    const fake = engineFetch(raw)
    const { plan } = await makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl })
    expect(fake.named('once_plan_repair')).toHaveLength(0)
    expect(plan.repaired).toBe(false)
    const textOf = new Map(sentences.map((sentence) => [sentence.id, sentence.text]))
    for (const point of plan.steps.flatMap((step) => step.points)) {
      for (const entry of point.quotes) expect(entry.quote).toBe(textOf.get(entry.sentenceId))
    }
  })

  it('undoes a line break escaped twice, and only that', async () => {
    const sentences = await storeDocument([
      textPage(1, 'A sentence that wraps\nover two lines. Another plain sentence here.'),
      textPage(2, 'The closing sentence. The very last one.'),
    ])
    const raw = fullRawPlan(sentences)
    const wrapped = sentences[0]
    expect(wrapped.text).toContain('\n')
    const quote = raw.steps[0].points[0].quotes.find((entry) => entry.sentenceId === wrapped.id)
    if (!quote) throw new Error('the fixture should quote the wrapped sentence')
    quote.quote = wrapped.text.replace('\n', '\\n')
    const fake = engineFetch(raw)
    const { plan } = await makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl })
    expect(fake.named('once_plan_repair')).toHaveLength(0)
    expect(plan.steps[0].points[0].quotes).toContainEqual({ sentenceId: wrapped.id, quote: wrapped.text })
  })

  it('removes a quote that still does not match after the repair and counts it', async () => {
    const sentences = await storeDocument(fifteenPages())
    const raw = fullRawPlan(sentences)
    const point = raw.steps[0].points[0]
    const extra = point.quotes[0]
    // The sentence is also explained elsewhere, so removing the bad quote leaves no gap.
    raw.steps[1].points.push(rawPoint(sentences.filter((sentence) => sentence.id === extra.sentenceId)))
    extra.quote = 'Not what the text says.'
    const fake = engineFetch(raw, repairOf({ corrections: [{ location: 'pt1', wrongId: extra.sentenceId, rightId: extra.sentenceId, quote: 'Still wrong.' }] }))
    const { plan } = await makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl })
    expect(plan.droppedQuotes).toBe(1)
    expect(JSON.stringify(plan)).not.toContain('Still wrong.')
    expect(plan.coverage.uncovered).toEqual([])
  })

  it('removes a point a correction leaves citing nothing', async () => {
    const sentences = await storeDocument(fifteenPages())
    const raw = fullRawPlan(sentences)
    const point = raw.steps[0].points[0]
    const restOfPoint = point.quotes.slice(1)
    point.quotes = [{ sentenceId: 's9999', quote: 'not in the text' }]
    raw.steps[1].points.push(rawPoint(sentences.filter((s) => restOfPoint.some((q) => q.sentenceId === s.id))))
    raw.steps[1].points.push(rawPoint(sentences.filter((s) => s.id === 's1')))
    const pointsBefore = raw.steps.flatMap((step) => step.points).length
    const fake = engineFetch(raw, repairOf({ corrections: [{ location: 'pt1', wrongId: 's9999', rightId: '', quote: '' }] }))
    const { plan } = await makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl })
    expect(plan.steps.flatMap((step) => step.points)).toHaveLength(pointsBefore - 1)
    expect(plan.coverage.uncovered).toEqual([])
  })

  it('retries a repair that breaks its schema within a small bound', async () => {
    const sentences = await storeDocument(fifteenPages())
    const { raw } = withGap(sentences)
    const fake = engineFetch(raw, {
      queue: { once_plan_repair: Array.from({ length: MAX_REPAIR_ATTEMPTS }, () => planResponse({ wrong: true })) },
    })
    const error = await makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl, sleep: noWait }).catch((err) => err)
    expect(error).toBeInstanceOf(PlanModelError)
    expect(fake.named('once_plan_repair')).toHaveLength(MAX_REPAIR_ATTEMPTS)
  })
})

describe('splitting by volume', () => {
  it('splits only because of the image cap, keeps each call under it and records it', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const pageDir = path.join(process.cwd(), 'data', 'pages', FINGERPRINT)
    await mkdir(pageDir, { recursive: true })
    const pages = []
    for (let page = 1; page <= 60; page += 1) {
      await writeFile(path.join(pageDir, `p${page}.png`), Buffer.from([page]))
      pages.push(
        textPage(page, `Page ${page} opens with a claim. Page ${page} closes with a claim.`, {
          image: `data/pages/${FINGERPRINT}/p${page}.png`,
        }),
      )
    }
    const sentences = await storeDocument(pages)
    const firstPart = sentences.filter((sentence) => sentence.page <= 50)
    const secondPart = sentences.filter((sentence) => sentence.page > 50)
    const fake = engineFetch(fullRawPlan(firstPart), { moreParts: [fullRawPlan(secondPart)] })

    const { plan } = await makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl })

    const reads = fake.named('once_understand')
    expect(reads).toHaveLength(2)
    for (const body of reads) {
      const images = userContent(body).filter((part) => part.type === 'input_image')
      expect(images.length).toBeLessThanOrEqual(50)
      expect(images.length).toBeGreaterThan(0)
    }
    expect(requestText(reads[0])).toContain('part 1 of 2 (pages 1 to 50)')
    expect(requestText(reads[1])).toContain('part 2 of 2 (pages 51 to 60)')
    expect(requestText(reads[0])).not.toContain(JSON.stringify(secondPart[0].text))

    expect(plan.volume.split).toBe(true)
    expect(plan.volume.reason).toBe('image-limit')
    expect(plan.volume.note).toContain('read in 2 parts')
    expect(plan.volume.parts.map((part) => [part.fromPage, part.toPage])).toEqual([
      [1, 50],
      [51, 60],
    ])

    expect(plan.steps.map((step) => step.kind)).toEqual([
      'context',
      'context',
      'problem',
      'problem',
      'attempts',
      'attempts',
      'answer',
      'answer',
      'applications',
      'applications',
    ])
    expect(plan.steps.map((step) => step.id)).toEqual(plan.steps.map((_, index) => `st${index + 1}`))
    expect(plan.coverage.uncovered).toEqual([])
    expect(plan.coverage.total).toBe(sentences.length)
    expect(fake.named('once_listen')).toHaveLength(1)
  })

  it('does not split a text that fits in one call', async () => {
    const sentences = await storeDocument(fifteenPages())
    const fake = engineFetch(fullRawPlan(sentences))
    const { plan } = await makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl })
    expect(fake.named('once_understand')).toHaveLength(1)
    expect(plan.volume.split).toBe(false)
    expect(plan.volume.reason).toBeNull()
    expect(plan.volume.parts).toEqual([{ fromPage: 1, toPage: 15, imagePages: [] }])
  })
})

describe('bad input', () => {
  it('reports an unknown document before any network call', async () => {
    const none = fakeFetch()
    await expect(makePlan(FINGERPRINT, { fetchImpl: none.fetchImpl })).rejects.toBeInstanceOf(
      SentenceDocumentNotFoundError,
    )
    await expect(makePlan('not-a-fingerprint', { fetchImpl: none.fetchImpl })).rejects.toBeInstanceOf(
      SentenceDocumentNotFoundError,
    )
    expect(none.callCount()).toBe(0)
  })

  it('reports a text with no readable pages yet', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(path.join(process.cwd(), 'data', 'originals'), { recursive: true })
    await writeFile(path.join(process.cwd(), 'data', 'originals', FINGERPRINT), 'words')
    const none = fakeFetch()
    await expect(makePlan(FINGERPRINT, { fetchImpl: none.fetchImpl })).rejects.toBeInstanceOf(
      ReadableNotBuiltError,
    )
    expect(none.callCount()).toBe(0)
  })

  it('refuses a text with no sentences, without paying', async () => {
    await storeDocument([textPage(1, '')])
    const none = fakeFetch()
    const error = await makePlan(FINGERPRINT, { fetchImpl: none.fetchImpl }).catch((err) => err)
    expect(error).toBeInstanceOf(PlanInputError)
    expect(toErrorResponse(error)).toEqual({
      status: 422,
      body: { error: 'This text has no sentences to explain.' },
    })
    expect(none.callCount()).toBe(0)
  })
})

describe('POST /api/documents/[fingerprint]/plan', () => {
  function post(body?: unknown, fingerprint = FINGERPRINT): Promise<Response> {
    return POST(
      new Request(`http://local/api/documents/${fingerprint}/plan`, {
        method: 'POST',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      { params: Promise.resolve({ fingerprint }) },
    )
  }

  it('makes the plan once and serves it from the store after that', async () => {
    const sentences = await storeDocument(fifteenPages())
    const fake = engineFetch(fullRawPlan(sentences))
    vi.stubGlobal('fetch', fake.fetchImpl)

    const first = await post()
    expect(first.status).toBe(200)
    const firstBody = await first.json()
    expect(firstBody.isCurrent).toBe(true)
    expect(firstBody.reused).toBe(false)
    expect(firstBody.plan.coverage.uncovered).toEqual([])

    const second = await post()
    const secondBody = await second.json()
    expect(second.status).toBe(200)
    expect(secondBody.reused).toBe(true)
    expect(secondBody.plan).toEqual(firstBody.plan)
    expect(fake.callCount()).toBe(CLEAN_RUN_CALLS)
  })

  it('passes a redo through', async () => {
    const sentences = await storeDocument(fifteenPages())
    putArtifact({
      fingerprint: FINGERPRINT,
      kind: 'plan',
      key: planArtifactKey(),
      model: PLAN_MODEL,
      promptVersion: 'plan-0',
      data: Buffer.from(JSON.stringify({ title: 'older plan' })),
    })
    const fake = engineFetch(fullRawPlan(sentences))
    vi.stubGlobal('fetch', fake.fetchImpl)

    const stale = await (await post()).json()
    expect(stale.isCurrent).toBe(false)
    expect(fake.callCount()).toBe(0)

    const redone = await (await post({ redo: true })).json()
    expect(redone.isCurrent).toBe(true)
    expect(fake.callCount()).toBe(CLEAN_RUN_CALLS)
  })

})

describe('GET /api/documents/[fingerprint]/plan', () => {
  function get(query = '', fingerprint = FINGERPRINT): Promise<Response> {
    return GET(new Request(`http://local/api/documents/${fingerprint}/plan${query}`), {
      params: Promise.resolve({ fingerprint }),
    })
  }

  function refuseModelCalls() {
    const none = fakeFetch()
    vi.stubGlobal('fetch', none.fetchImpl)
    return none
  }

  it('says clearly that no plan exists yet, and never calls the model', async () => {
    await storeDocument(fifteenPages())
    const none = refuseModelCalls()

    const response = await get()

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ fingerprint: FINGERPRINT, generated: false, message: 'No plan has been generated for this text yet.' })
    expect(none.callCount()).toBe(0)
  })

  it('returns the stored plan', async () => {
    const sentences = await storeDocument(fifteenPages())
    const { plan } = await makePlan(FINGERPRINT, {
      fetchImpl: engineFetch(fullRawPlan(sentences)).fetchImpl,
    })
    const none = refuseModelCalls()

    const english = await (await get('?language=en')).json()
    expect(english.generated).toBe(true)
    expect(english.isCurrent).toBe(true)
    expect(english.plan).toEqual(plan)

    expect(none.callCount()).toBe(0)
  })

  it('returns the stored plan when none is asked for', async () => {
    const sentences = await storeDocument(fifteenPages())
    await makePlan(FINGERPRINT, { fetchImpl: engineFetch(fullRawPlan(sentences)).fetchImpl })
    const none = refuseModelCalls()
    const body = await (await get()).json()
    expect(body.generated).toBe(true)
    expect(none.callCount()).toBe(0)
  })

  it('labels a plan from an older prompt as not current', async () => {
    await storeDocument(fifteenPages())
    putArtifact({
      fingerprint: FINGERPRINT,
      kind: 'plan',
      key: planArtifactKey(),
      model: PLAN_MODEL,
      promptVersion: 'plan-0',
      data: Buffer.from(JSON.stringify({ title: 'older plan' })),
    })
    const none = refuseModelCalls()
    const body = await (await get('?language=en')).json()
    expect(body.generated).toBe(true)
    expect(body.isCurrent).toBe(false)
    expect(none.callCount()).toBe(0)
  })

  it('answers 404 for an unknown document', async () => {
    await storeDocument(fifteenPages())
    expect((await get('', 'b'.repeat(64))).status).toBe(404)
    expect((await get('', 'not-a-fingerprint')).status).toBe(404)
  })
})

describe('what is written to disk', () => {
  it('is the plan as JSON, under the document it belongs to', async () => {
    const sentences = await storeDocument(fifteenPages())
    const { plan } = await makePlan(FINGERPRINT, {
      fetchImpl: engineFetch(fullRawPlan(sentences)).fetchImpl,
    })
    const [artifact] = listArtifacts(FINGERPRINT, 'plan')
    expect(artifact.path.startsWith(`data/artifacts/${FINGERPRINT}/`)).toBe(true)
    expect(JSON.parse(await readFile(path.join(process.cwd(), artifact.path), 'utf8'))).toEqual(plan)
  })
})
