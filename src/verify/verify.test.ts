import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PLAN_MODEL, PROMPT_VERSION, planArtifactKey } from '@/deepread/deepread'
import { fifteenPages, fullRawPlan, rawPoint, storeDocument, textPage } from '@/deepread/fixtures'
import { toStoredPlan } from '@/deepread/normalize'
import type { RawPlan, RawSource } from '@/deepread/schema'
import { toErrorResponse } from '@/errors/errors'
import type { Plan, PlanPoint, Sentence } from '@/lib/types'
import { SentenceDocumentNotFoundError, buildSentenceDocument } from '@/sentences/sentences'
import { closeDb, putArtifact, resetStoreForTests } from '@/store/store'
import { GET } from '../../app/api/documents/[fingerprint]/reading/route'
import { OriginalTamperedError, verifyOriginal, verifyPlan } from './verify'

const TEXT = 'The first claim. The second claim. The third claim. The fourth claim. The fifth claim.'

function sentencesOf(text = TEXT): Sentence[] {
  return buildSentenceDocument({
    fingerprint: 'a'.repeat(64),
    kind: 'text',
    pageCount: 1,
    fullText: text,
    pages: [textPage(1, text)],
  }).sentences
}

function storedPlan(
  raw: RawPlan,
  sentences: readonly Sentence[],
  fingerprint = 'a'.repeat(64),
  citations: { url: string; title: string | null }[] = [],
): Plan {
  return toStoredPlan({
    fingerprint,
    model: PLAN_MODEL,
    promptVersion: PROMPT_VERSION,
    createdAt: '2026-01-01T00:00:00.000Z',
    raw,
    sentences,
    pageCount: 15,
    citations,
    volume: {
      split: false,
      reason: null,
      note: null,
      parts: [],
      imagePages: [],
      missingImagePages: [],
    },
    usage: {
      calls: 1,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      webSearches: 0,
    },
    repaired: false,
    droppedQuotes: 0,
  })
}

/** A plan with one point per group of sentences and nothing marked skippable. */
function planOf(groups: readonly (readonly Sentence[])[], sentences: readonly Sentence[]): Plan {
  return storedPlan(
    {
      title: 'A title',
      steps: [
        {
          kind: 'context',
          title: 'The context',
          points: groups.map((group) => rawPoint(group)),
        },
      ],
      questions: [], pageNotes: [], skippable: [], figures: [],
    },
    sentences,
  )
}

function points(plan: Plan): PlanPoint[] {
  return plan.steps.flatMap((step) => step.points)
}

describe('verifyPlan', () => {
  it('catches an altered quote and drops it', () => {
    const sentences = sentencesOf()
    const plan = planOf([sentences], sentences)
    points(plan)[0].quotes[1].quote = 'The second claim, slightly improved.'

    const { plan: verified, report } = verifyPlan(plan, sentences)

    expect(report.quotesChecked).toBe(sentences.length)
    expect(report.quotesDropped).toBe(1)
    expect(report.quotesReanchored).toBe(0)
    expect(report.droppedPointIds).toEqual([])
    expect(points(verified)[0].sentenceIds).not.toContain(sentences[1].id)
    expect(points(verified)[0].quotes.map((entry) => entry.quote)).not.toContain(
      'The second claim, slightly improved.',
    )
    expect(report.states[sentences[1].id]).toBe('uncovered')
    expect(report.coverage.uncoveredIds).toEqual([sentences[1].id])
    expect(verified.coverage.uncovered).toEqual([sentences[1].id])
    expect(verified.droppedQuotes).toBe(1)
  })

  it('does not accept a quote that differs by one character or only by spacing', () => {
    const sentences = sentencesOf()
    const plan = planOf([sentences.slice(0, 1), sentences.slice(1)], sentences)
    points(plan)[0].quotes[0].quote = sentences[0].text.replace('first', 'First')
    points(plan)[1].quotes[0].quote = `${sentences[1].text} `

    const { report } = verifyPlan(plan, sentences)

    expect(report.quotesDropped).toBe(2)
    expect(report.coverage.uncoveredIds).toEqual([sentences[0].id, sentences[1].id])
  })

  it('moves a quote filed under the wrong id to the sentence that says it', () => {
    const sentences = sentencesOf()
    const plan = planOf([sentences.slice(0, 2), sentences.slice(2)], sentences)
    points(plan)[0].quotes[1].sentenceId = sentences[3].id

    const { plan: verified, report } = verifyPlan(plan, sentences)

    expect(report.quotesReanchored).toBe(1)
    expect(report.quotesDropped).toBe(0)
    expect(points(verified)[0].sentenceIds).toEqual([sentences[0].id, sentences[1].id])
    expect(report.coverage.uncovered).toBe(0)
  })

  it('moves a quote citing a sentence that does not exist', () => {
    const sentences = sentencesOf()
    const plan = planOf([sentences], sentences)
    points(plan)[0].quotes[4].sentenceId = 'no-such-sentence'

    const { plan: verified, report } = verifyPlan(plan, sentences)

    expect(report.quotesReanchored).toBe(1)
    expect(points(verified)[0].quotes[4]).toEqual({
      sentenceId: sentences[4].id,
      quote: sentences[4].text,
    })
  })

  it('takes the closest copy of a repeated sentence when moving a quote', () => {
    const sentences = sentencesOf(
      'The same line. A first claim. A second claim. A third claim. The same line.',
    )
    const repeated = [sentences[0].id, sentences[4].id]
    expect(sentences[0].text).toBe(sentences[4].text)

    const plan = planOf([sentences.slice(1, 4)], sentences)
    points(plan)[0].quotes.push({ sentenceId: sentences[3].id, quote: sentences[4].text })

    const { plan: verified, report } = verifyPlan(plan, sentences)

    // Sentence 3 keeps its own quote, and the copy at position 4 is closer than the one at 0.
    expect(report.quotesReanchored).toBe(1)
    expect(points(verified)[0].sentenceIds).toContain(repeated[1])
    expect(points(verified)[0].sentenceIds).not.toContain(repeated[0])
    expect(points(verified)[0].sentenceIds).toContain(sentences[3].id)
  })

  it('keeps one quote when a moved quote lands on a sentence the point already cites', () => {
    const sentences = sentencesOf()
    const plan = planOf([sentences.slice(0, 2), sentences.slice(2)], sentences)
    points(plan)[0].quotes.push({ sentenceId: sentences[4].id, quote: sentences[0].text })

    const { plan: verified, report } = verifyPlan(plan, sentences)

    expect(points(verified)[0].sentenceIds).toEqual([sentences[0].id, sentences[1].id])
    expect(report.quotesChecked).toBe(sentences.length + 1)
    expect(report.quotesDropped).toBe(1)
    expect(report.coverage.uncovered).toBe(0)
  })

  it('drops a point that loses every quote, and its sentences become uncovered', () => {
    const sentences = sentencesOf()
    const plan = planOf([sentences.slice(0, 3), sentences.slice(3)], sentences)
    const [, second] = points(plan)
    second.quotes = second.quotes.map((entry) => ({ ...entry, quote: 'Not in the text.' }))

    const { plan: verified, report } = verifyPlan(plan, sentences)

    expect(report.droppedPointIds).toEqual([second.id])
    expect(points(verified).map((point) => point.id)).not.toContain(second.id)
    expect(report.quotesDropped).toBe(2)
    expect(report.coverage.uncoveredIds).toEqual([sentences[3].id, sentences[4].id])
    expect(report.coverage.explained).toBe(3)
  })

  it('keeps a sentence explained when another surviving point also cites it', () => {
    const sentences = sentencesOf()
    const plan = planOf([sentences.slice(0, 3), sentences.slice(2)], sentences)
    const [, second] = points(plan)
    second.quotes = second.quotes.map((entry) => ({ ...entry, quote: 'Not in the text.' }))

    const { report } = verifyPlan(plan, sentences)

    expect(report.droppedPointIds).toEqual([second.id])
    expect(report.states[sentences[2].id]).toBe('explained')
    expect(report.coverage.uncoveredIds).toEqual([sentences[3].id, sentences[4].id])
  })

  it('reads zero uncovered on a full plan and accounts for every sentence', () => {
    const pages = fifteenPages()
    const sentences = buildSentenceDocument({
      fingerprint: 'a'.repeat(64),
      kind: 'pdf',
      pageCount: pages.length,
      fullText: pages.map((page) => page.text).join('\n'),
      pages,
    }).sentences
    const plan = storedPlan(fullRawPlan(sentences), sentences)

    const { plan: verified, report } = verifyPlan(plan, sentences)

    expect(report.quotesDropped).toBe(0)
    expect(report.quotesReanchored).toBe(0)
    expect(report.droppedPointIds).toEqual([])
    expect(report.coverage.uncovered).toBe(0)
    expect(report.coverage.uncoveredIds).toEqual([])
    expect(report.coverage.total).toBe(sentences.length)
    expect(report.coverage.skippable).toBe(4)
    expect(report.coverage.explained + report.coverage.skippable).toBe(sentences.length)
    expect(Object.keys(report.states)).toHaveLength(sentences.length)
    expect(verified).toEqual(plan)
  })

  it('counts a sentence as explained when it is marked skippable and also proven', () => {
    const sentences = sentencesOf()
    const plan = planOf([sentences], sentences)
    plan.skippable = [{ sentenceId: sentences[0].id, reason: 'Boilerplate.' }]

    const { plan: verified, report } = verifyPlan(plan, sentences)

    expect(report.states[sentences[0].id]).toBe('explained')
    expect(report.coverage.skippable).toBe(0)
    expect(verified.skippable).toEqual([])
  })

  it('leaves a sentence skippable when the only point citing it is dropped', () => {
    const sentences = sentencesOf()
    const plan = planOf([sentences.slice(0, 4), sentences.slice(4)], sentences)
    plan.skippable = [{ sentenceId: sentences[4].id, reason: 'Boilerplate.' }]
    points(plan)[1].quotes[0].quote = 'Not in the text.'

    const { plan: verified, report } = verifyPlan(plan, sentences)

    expect(report.states[sentences[4].id]).toBe('skippable')
    expect(report.coverage.uncovered).toBe(0)
    expect(verified.skippable).toEqual([{ sentenceId: sentences[4].id, reason: 'Boilerplate.' }])
  })

  it('holds outside background and inference to the same proof as the text', () => {
    const sentences = sentencesOf()
    const inference: RawSource = { kind: 'inference', url: '', title: '' }
    const url = 'https://example.com/background'
    const external: RawSource = { kind: 'external', url, title: 'Background' }
    const raw: RawPlan = {
      title: 'A title',
      steps: [
        {
          kind: 'context',
          title: 'The context',
          points: [
            rawPoint(sentences.slice(0, 2), { source: external }),
            rawPoint(sentences.slice(2, 3), { source: external }),
            rawPoint([], { source: inference }),
            rawPoint(sentences.slice(3)),
          ],
        },
      ],
      questions: [], pageNotes: [], skippable: [], figures: [],
    }
    const plan = storedPlan(raw, sentences, 'a'.repeat(64), [{ url, title: 'Background' }])
    const [proven, altered, empty] = points(plan)
    expect(proven.source.kind).toBe('external')
    altered.quotes[0].quote = 'Not in the text.'

    const { plan: verified, report } = verifyPlan(plan, sentences)

    expect(points(verified).find((point) => point.id === proven.id)?.source.kind).toBe('external')
    expect(report.states[sentences[0].id]).toBe('explained')
    expect(report.droppedPointIds).toEqual([altered.id, empty.id])
    expect(report.states[sentences[2].id]).toBe('uncovered')
  })

  it('recomputes sentence ids from the quotes rather than trusting the stored list', () => {
    const sentences = sentencesOf()
    const plan = planOf([sentences.slice(0, 2)], sentences)
    points(plan)[0].sentenceIds = sentences.map((sentence) => sentence.id)

    const { plan: verified, report } = verifyPlan(plan, sentences)

    expect(points(verified)[0].sentenceIds).toEqual([sentences[0].id, sentences[1].id])
    expect(report.coverage.explained).toBe(2)
    expect(report.coverage.uncoveredIds).toEqual(sentences.slice(2).map((sentence) => sentence.id))
  })

  it('does not change its input', () => {
    const sentences = sentencesOf()
    const plan = planOf([sentences.slice(0, 3), sentences.slice(3)], sentences)
    points(plan)[0].quotes[1].quote = 'Not in the text.'
    points(plan)[0].quotes[2].sentenceId = sentences[4].id
    points(plan)[1].quotes = []
    plan.skippable = [{ sentenceId: sentences[0].id, reason: 'Boilerplate.' }]
    const planBefore = structuredClone(plan)
    const sentencesBefore = structuredClone(sentences)

    const { plan: verified } = verifyPlan(plan, sentences)
    verified.title = 'Changed afterward'
    points(verified)[0].quotes[0].quote = 'Changed afterward'

    expect(plan).toEqual(planBefore)
    expect(sentences).toEqual(sentencesBefore)
  })

  it('finds nothing more to do on a plan it has already verified', () => {
    const sentences = sentencesOf()
    const plan = planOf([sentences.slice(0, 3), sentences.slice(3)], sentences)
    points(plan)[0].quotes[0].quote = 'Not in the text.'
    points(plan)[0].quotes[1].sentenceId = sentences[3].id

    const first = verifyPlan(plan, sentences)
    const second = verifyPlan(first.plan, sentences)

    expect(second.report.quotesDropped).toBe(0)
    expect(second.report.quotesReanchored).toBe(0)
    expect(second.plan).toEqual(first.plan)
    expect(second.report.coverage).toEqual(first.report.coverage)
  })
})

describe('with stored files', () => {
  let workDir: string
  let previousCwd: string

  beforeEach(async () => {
    previousCwd = process.cwd()
    workDir = await mkdtemp(path.join(tmpdir(), 'once-verify-'))
    process.chdir(workDir)
    resetStoreForTests()
  })

  afterEach(async () => {
    closeDb()
    process.chdir(previousCwd)
    await rm(workDir, { recursive: true, force: true })
    vi.unstubAllGlobals()
  })

  async function storeOriginal(bytes: string): Promise<string> {
    const fingerprint = createHash('sha256').update(bytes).digest('hex')
    await mkdir(path.join('data', 'originals'), { recursive: true })
    await writeFile(path.join('data', 'originals', fingerprint), bytes)
    return fingerprint
  }

  async function storeLink(fingerprint: string): Promise<void> {
    await mkdir(path.join('data', 'links'), { recursive: true })
    await writeFile(
      path.join('data', 'links', `${fingerprint}.json`),
      JSON.stringify({ url: 'https://example.com/' }),
    )
  }

  function storePlan(plan: Plan, promptVersion = PROMPT_VERSION): void {
    putArtifact({
      fingerprint: plan.fingerprint,
      kind: 'plan',
      key: planArtifactKey(),
      model: PLAN_MODEL,
      promptVersion,
      data: Buffer.from(JSON.stringify(plan), 'utf8'),
    })
  }

  function reading(fingerprint: string, query = ''): Promise<Response> {
    return GET(new Request(`http://localhost/api/documents/${fingerprint}/reading${query}`), {
      params: Promise.resolve({ fingerprint }),
    })
  }

  async function storeFullText(): Promise<{ fingerprint: string; sentences: Sentence[]; plan: Plan }> {
    const fingerprint = await storeOriginal('the original bytes')
    const sentences = await storeDocument(fifteenPages(), 'pdf', fingerprint)
    const plan = storedPlan(fullRawPlan(sentences), sentences, fingerprint)
    return { fingerprint, sentences, plan }
  }

  describe('verifyOriginal', () => {
    it('passes an original that still matches its fingerprint', async () => {
      const fingerprint = await storeOriginal('the original bytes')
      await expect(verifyOriginal(fingerprint)).resolves.toBeUndefined()
    })

    it('rejects an original that has changed, with a clear message and status', async () => {
      const fingerprint = await storeOriginal('the original bytes')
      await writeFile(path.join('data', 'originals', fingerprint), 'the original bytes, edited')

      const error = await verifyOriginal(fingerprint).catch((caught: unknown) => caught)

      expect(error).toBeInstanceOf(OriginalTamperedError)
      expect((error as Error).message).toMatch(/no longer matches its fingerprint/)
      expect(toErrorResponse(error).status).toBe(409)
      expect(toErrorResponse(error).body.error).toMatch(/no longer matches its fingerprint/)
    })

    it('skips a link, which has no stored original', async () => {
      const fingerprint = 'b'.repeat(64)
      await storeLink(fingerprint)
      await expect(verifyOriginal(fingerprint)).resolves.toBeUndefined()
    })

    it('treats a text with neither an original nor a link as not found', async () => {
      await expect(verifyOriginal('c'.repeat(64))).rejects.toBeInstanceOf(
        SentenceDocumentNotFoundError,
      )
    })

    it('refuses a fingerprint that is not one, before touching the disk', async () => {
      await expect(verifyOriginal('../../etc/passwd')).rejects.toBeInstanceOf(
        SentenceDocumentNotFoundError,
      )
    })
  })

  describe('GET reading', () => {
    it('returns the verified plan and report without any network call', async () => {
      const fakeFetch = vi.fn()
      vi.stubGlobal('fetch', fakeFetch)
      const { fingerprint, sentences, plan } = await storeFullText()
      storePlan(plan)

      const response = await reading(fingerprint, '?language=en')
      const body = await response.json()

      expect(fakeFetch).not.toHaveBeenCalled()
      expect(response.status).toBe(200)
      expect(body.generated).toBe(true)
      expect(body.isCurrent).toBe(true)
            expect(body.plan).toEqual(plan)
      expect(body.report.coverage.total).toBe(sentences.length)
      expect(body.report.coverage.uncovered).toBe(0)
      expect(body.report.quotesDropped).toBe(0)
    })

    it('verifies what is stored, so an altered quote in the stored plan is caught', async () => {
      const { fingerprint, sentences, plan } = await storeFullText()
      points(plan)[0].quotes[0].quote = 'Not in the text.'
      storePlan(plan)

      const body = await (await reading(fingerprint)).json()

      expect(body.report.quotesDropped).toBe(1)
      expect(body.report.coverage.uncoveredIds).toEqual([sentences[0].id])
      expect(body.plan.coverage.uncovered).toEqual([sentences[0].id])
    })

    it('says a plan is not current when an older prompt made it', async () => {
      const { fingerprint, plan } = await storeFullText()
      storePlan(plan, 'an-older-prompt')

      const body = await (await reading(fingerprint)).json()

      expect(body.generated).toBe(true)
      expect(body.isCurrent).toBe(false)
    })

    it('rejects a tampered original before reading the plan', async () => {
      const fakeFetch = vi.fn()
      vi.stubGlobal('fetch', fakeFetch)
      const { fingerprint, plan } = await storeFullText()
      storePlan(plan)
      await writeFile(path.join('data', 'originals', fingerprint), 'edited bytes')

      const response = await reading(fingerprint)
      const body = await response.json()

      expect(response.status).toBe(409)
      expect(body.error).toMatch(/no longer matches its fingerprint/)
      expect(body.plan).toBeUndefined()
      expect(fakeFetch).not.toHaveBeenCalled()
    })

    it('reads a link without an original to check', async () => {
      const fingerprint = 'b'.repeat(64)
      await storeLink(fingerprint)
      const sentences = await storeDocument(fifteenPages(), 'url', fingerprint)
      storePlan(storedPlan(fullRawPlan(sentences), sentences, fingerprint))

      const response = await reading(fingerprint)
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(body.report.coverage.uncovered).toBe(0)
    })

    it('says so when no plan has been generated, without calling a model', async () => {
      const fakeFetch = vi.fn()
      vi.stubGlobal('fetch', fakeFetch)
      const { fingerprint } = await storeFullText()

      const response = await reading(fingerprint, '?language=zh')
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(body.generated).toBe(false)
      expect(body.message).toBe('No plan has been generated for this text yet.')
      expect(body.report).toBeUndefined()
      expect(fakeFetch).not.toHaveBeenCalled()
    })

    it('ignores a language parameter', async () => {
      const { fingerprint } = await storeFullText()
      const response = await reading(fingerprint, '?language=fr')
      expect(response.status).toBe(200)
    })

    it('answers 404 for a text it has never seen', async () => {
      const response = await reading('d'.repeat(64))
      expect(response.status).toBe(404)
    })
  })
})
