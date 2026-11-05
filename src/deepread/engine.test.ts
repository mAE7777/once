import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, listArtifacts, resetStoreForTests } from '@/store/store'
import { MAX_REPAIR_ROUNDS, makePlan, type EngineStage } from './deepread'
import { ENGINE_ARTIFACT_KIND, assignSentences, listenerFindings } from './engine'
import { outlineShapeProblems } from './engine'
import { CLEAN_LISTENER, FINGERPRINT, UNDERSTANDING, engineFetch, errorResponse, fifteenPages, fullRawPlan, planResponse, sseResponse, storeDocument, streamBody } from './fixtures'
import { lintNarration } from './lints'
import { sectionRange, type Outline } from './stages'

let workDir: string
let previousCwd: string
const originalKey = process.env.META_API_KEY
const noWait = async () => undefined

beforeEach(async () => {
  previousCwd = process.cwd()
  workDir = await mkdtemp(path.join(tmpdir(), 'once-engine-'))
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
  vi.unstubAllGlobals()
})

function namesInOrder(bodies: Record<string, unknown>[]): string[] {
  return bodies.map((body) => (body.text as { format: { name: string } }).format.name)
}

function listenerSaying(pointId: string, words: string) {
  return planResponse({
    ...CLEAN_LISTENER,
    points: [{ pointId, untaught: [{ words, why: 'Nobody explained it.' }], jumps: [], abstractWithNoSituation: [], couldNotRetell: [], soundsWrong: [], contradicts: [], repeats: [] }],
  })
}

describe('stage flow', () => {
  it('runs the stages in order and reports each to the caller', async () => {
    const sentences = await storeDocument(fifteenPages())
    const fake = engineFetch(fullRawPlan(sentences))
    const stages: EngineStage[] = []
    const { plan } = await makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl, onStage: (stage) => stages.push(stage) })

    expect(namesInOrder(fake.bodies).slice(0, 3)).toEqual(['once_understand', 'once_research', 'once_outline'])
    expect(namesInOrder(fake.bodies).at(-1)).toBe('once_listen')
    expect(fake.named('once_section')).toHaveLength(5)
    expect(stages).toEqual(['understanding', 'researching', 'outlining', 'writing', 'checking'])
    expect(plan.report?.stages.map((stage) => stage.name)).toEqual(['understand', 'research', 'outline', 'write', 'listen'])
    expect(plan.report?.remaining).toEqual([])
    expect(plan.report?.retell).toContain('by hand')
    expect(plan.report?.costUsd).toBeGreaterThan(0)
  })

  it('writes sections at the same time', async () => {
    const sentences = await storeDocument(fifteenPages())
    const inner = engineFetch(fullRawPlan(sentences))
    let running = 0
    let most = 0
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      const isSection = String(init?.body).includes('"once_section"')
      if (isSection) {
        running += 1
        most = Math.max(most, running)
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      const response = await inner.fetchImpl(url as string, init)
      if (isSection) running -= 1
      return response
    }) as unknown as typeof fetch
    await makePlan(FINGERPRINT, { fetchImpl })
    expect(most).toBeGreaterThan(1)
  })

  it('gives a writer the plan, what has grown already and how the last section ends', async () => {
    const sentences = await storeDocument(fifteenPages())
    const fake = engineFetch(fullRawPlan(sentences))
    await makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl })
    const second = JSON.stringify(fake.named('once_section').find((body) => JSON.stringify(body.input).includes('Section 2 of 5')))
    expect(second).toContain('The whole plan')
    expect(second).toContain('The idea of The context')
    expect(second).toContain('What is still broken.')
    expect(second).not.toContain('The idea of The attempts')
  })

  it('asks one research call per question and keeps only links it really retrieved', async () => {
    const sentences = await storeDocument(fifteenPages())
    const raw = fullRawPlan(sentences)
    raw.steps[0].points[0].source = { kind: 'external', url: 'https://found.example/a', title: 'A' }
    raw.steps[1].points[0].source = { kind: 'external', url: 'https://invented.example/b', title: 'B' }
    const fake = engineFetch(raw, {
      results: [{ url: 'https://found.example/a', title: 'Found' }],
      queue: { once_understand: [planResponse({ ...UNDERSTANDING, researchQuestions: ['One?', 'Two?', 'Three?'] })] },
    })
    const { plan } = await makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl })
    expect(fake.named('once_research')).toHaveLength(3)
    expect(JSON.stringify(fake.named('once_research')[1].input)).toContain('Two?')
    expect(plan.steps[0].points[0].source.url).toBe('https://found.example/a')
    expect(plan.steps[1].points[0].source.kind).toBe('inference')
  })

  it('gives every writer the same shared facts', async () => {
    const sentences = await storeDocument(fifteenPages())
    const fake = engineFetch(fullRawPlan(sentences))
    await makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl })
    for (const body of fake.named('once_section')) expect(JSON.stringify(body.input)).toContain('The desk has ten letters.')
  })

  it('scales the number of sections with length', () => {
    expect(sectionRange(30).max).toBeLessThan(sectionRange(600).min + 5)
    expect(sectionRange(600).min).toBeGreaterThan(sectionRange(30).min)
  })

  it('hands a sentence the outline left out to the section before it', async () => {
    const sentences = await storeDocument(fifteenPages())
    const outline = {
      sections: [
        { sentenceRanges: [{ fromSentenceId: sentences[0].id, toSentenceId: sentences[0].id }] },
        { sentenceRanges: [{ fromSentenceId: sentences[2].id, toSentenceId: sentences.at(-2)?.id as string }] },
      ],
      skippable: [{ fromSentenceId: sentences.at(-1)?.id as string, toSentenceId: sentences.at(-1)?.id as string, reason: 'x' }],
    } as unknown as Outline
    const assigned = assignSentences(outline, sentences)
    expect(assigned[0].map((sentence) => sentence.id)).toEqual([sentences[0].id, sentences[1].id])
    expect(assigned.flat()).toHaveLength(sentences.length - 1)
  })
})

describe('resume after a crash', () => {
  it('stops at a failing section and picks up there on the next try', async () => {
    const sentences = await storeDocument(fifteenPages())
    const raw = fullRawPlan(sentences)
    const refuse = () => errorResponse(400, 'refused')
    const first = engineFetch(raw, { queue: { once_section: [refuse] } })
    await expect(makePlan(FINGERPRINT, { fetchImpl: first.fetchImpl, sleep: noWait })).rejects.toThrow('refused')
    expect(listArtifacts(FINGERPRINT, 'plan')).toEqual([])

    const second = engineFetch(raw)
    const { plan } = await makePlan(FINGERPRINT, { fetchImpl: second.fetchImpl, sleep: noWait })
    expect(second.named('once_understand')).toHaveLength(0)
    expect(second.named('once_research')).toHaveLength(0)
    expect(second.named('once_outline')).toHaveLength(0)
    expect(second.named('once_section').length).toBeLessThan(5)
    expect(second.named('once_section').length).toBeGreaterThan(0)
    expect(plan.steps).toHaveLength(5)
    // What the first try already paid for still counts in the plan's usage.
    expect(plan.usage.calls).toBe(3 + 5 + 1)
  })
})

describe('the cold listener', () => {
  it('receives only the narration: no text, no outline, no notes', async () => {
    const sentences = await storeDocument(fifteenPages())
    const raw = fullRawPlan(sentences)
    const fake = engineFetch(raw)
    await makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl })
    const body = fake.named('once_listen')[0]
    const sent = JSON.stringify(body)
    for (const sentence of sentences) expect(sent).not.toContain(sentence.text)
    expect(sent).not.toContain('A person at a desk with ten letters')
    expect(sent).not.toContain('What is still broken')
    expect(sent).not.toContain('People at a desk')
    expect(sent).not.toContain('The context')
    expect(sent).toContain('People were doing this by hand.')
    expect(body.tools).toBeUndefined()
  })

  it('reports contradictions and repeats as findings', () => {
    const findings = listenerFindings(
      {
        ...CLEAN_LISTENER,
        points: [{ pointId: 'pt1', untaught: [], jumps: [], abstractWithNoSituation: [], couldNotRetell: [], contradicts: ['Says 100 years, earlier 200.'], repeats: ['Sets up the shop again.'], soundsWrong: [] }],
      },
      [{ pointId: 'pt1', text: 'A shop.' }],
    )
    expect(findings.map((entry) => entry.kind)).toEqual(['contradiction', 'repeat'])
  })

  it('drops a claimed untaught word that the point does not contain', () => {
    const findings = listenerFindings(
      {
        ...CLEAN_LISTENER,
        points: [
          { pointId: 'pt1', untaught: [{ words: 'quantum', why: 'x' }, { words: 'Attention', why: 'y' }], jumps: [], abstractWithNoSituation: [], couldNotRetell: [], soundsWrong: [], contradicts: [], repeats: [] },
          { pointId: 'pt9', untaught: [], jumps: ['a jump'], abstractWithNoSituation: [], couldNotRetell: [], soundsWrong: [], contradicts: [], repeats: [] },
        ],
      },
      [{ pointId: 'pt1', text: 'Attention means looking back.' }],
    )
    expect(findings).toEqual([{ pointId: 'pt1', kind: 'untaught', detail: '"Attention": y' }])
  })
})

describe('repair', () => {
  const rewritten = (pointId: string, text: string) =>
    planResponse({ points: [{ pointId, spoken: [{ text, pauseBefore: false, stuckReason: '' }] }] })

  it('rewrites only flagged points, keeps their quotes, then checks again', async () => {
    const sentences = await storeDocument(fifteenPages())
    const raw = fullRawPlan(sentences)
    const fake = engineFetch(raw, {
      queue: {
        once_listen: [listenerSaying('pt2', 'Attention')],
        once_rewrite: [rewritten('pt2', 'A clerk reads back over the letter while writing.')],
      },
    })
    const { plan } = await makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl })
    expect(fake.named('once_listen')).toHaveLength(2)
    expect(fake.named('once_rewrite')).toHaveLength(1)
    const points = plan.steps.flatMap((step) => step.points)
    expect(points[1].spoken).toBe('A clerk reads back over the letter while writing.')
    expect(points[0].spoken).toContain('People were doing this by hand.')
    expect(points[1].quotes).toEqual(raw.steps[1].points[0].quotes)
    expect(plan.report?.before.listener).toBe(1)
    expect(plan.report?.after.listener).toBe(0)
    expect(plan.report?.repairRounds).toBe(1)
    const request = JSON.stringify(fake.named('once_rewrite')[0].input)
    expect(request).toContain('Rewrite these points')
    expect(request).toContain('pt2')
    expect(request).toContain('Attention')
  })

  it('ignores a rewrite of a point nobody flagged', async () => {
    const sentences = await storeDocument(fifteenPages())
    const fake = engineFetch(fullRawPlan(sentences), {
      queue: {
        once_listen: [listenerSaying('pt2', 'Attention')],
        once_rewrite: [rewritten('pt1', 'Sneaked in.')],
      },
    })
    const { plan } = await makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl })
    expect(JSON.stringify(plan.steps)).not.toContain('Sneaked in.')
  })

  it('stops at the bound and keeps the best version with what remains, never failing the reader', async () => {
    const sentences = await storeDocument(fifteenPages())
    const stubborn = () => listenerSaying('pt1', 'Attention')()
    const fake = engineFetch(fullRawPlan(sentences), {
      queue: { once_listen: Array.from({ length: MAX_REPAIR_ROUNDS + 5 }, () => stubborn) },
    })
    const { plan } = await makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl })
    expect(fake.named('once_listen')).toHaveLength(MAX_REPAIR_ROUNDS + 1)
    expect(fake.named('once_rewrite')).toHaveLength(MAX_REPAIR_ROUNDS)
    expect(plan.report?.remaining).toEqual([{ pointId: 'pt1', kind: 'untaught', detail: '"Attention": Nobody explained it.' }])
    expect(listArtifacts(FINGERPRINT, 'plan')).toHaveLength(1)
  })

  it('keeps repairing however long the wait has run, up to the round limit', async () => {
    const sentences = await storeDocument(fifteenPages())
    const stubborn = () => listenerSaying('pt1', 'Attention')()
    const fake = engineFetch(fullRawPlan(sentences), {
      queue: { once_listen: Array.from({ length: MAX_REPAIR_ROUNDS + 5 }, () => stubborn) },
    })
    let clock = 0
    const now = () => {
      clock += 400_000
      return clock
    }
    const { plan } = await makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl, now })
    expect(fake.named('once_rewrite')).toHaveLength(MAX_REPAIR_ROUNDS)
    expect(fake.named('once_listen')).toHaveLength(MAX_REPAIR_ROUNDS + 1)
    expect(plan.report?.notes.join(' ')).not.toContain('Repair stopped')
  })

  it('keeps an earlier version when a repair makes things worse', async () => {
    const sentences = await storeDocument(fifteenPages())
    const worse = planResponse({
      ...CLEAN_LISTENER,
      points: [
        { pointId: 'pt1', untaught: [], jumps: ['one', 'two', 'three'], abstractWithNoSituation: [], couldNotRetell: [], soundsWrong: [], contradicts: [], repeats: [] },
      ],
    })
    const fake = engineFetch(fullRawPlan(sentences), {
      queue: {
        once_listen: [listenerSaying('pt2', 'Attention'), worse, worse, worse],
        once_rewrite: [rewritten('pt2', 'Worse words.')],
      },
    })
    const { plan } = await makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl })
    expect(JSON.stringify(plan.steps)).not.toContain('Worse words.')
    expect(plan.report?.after.listener).toBe(1)
  })

  it('sends a lint finding to repair without the listener raising it', async () => {
    const sentences = await storeDocument(fifteenPages())
    const raw = fullRawPlan(sentences)
    raw.steps[0].points[0].spoken = [{ text: 'It grows like n squared, as we will see later.', pauseBefore: false, stuckReason: '' }]
    const fake = engineFetch(raw, { queue: { once_rewrite: [rewritten('pt1', 'Twenty words need twenty steps.')] } })
    const { plan } = await makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl })
    expect(plan.report?.before.lint).toBeGreaterThan(0)
    expect(plan.report?.after.lint).toBe(0)
    expect(plan.steps[0].points[0].spoken).toBe('Twenty words need twenty steps.')
  })

  it('keeps the plan when the listener cannot run, and says so', async () => {
    const sentences = await storeDocument(fifteenPages())
    const down = () => errorResponse(503, 'down')
    const fake = engineFetch(fullRawPlan(sentences), { queue: { once_listen: [down, down, down] } })
    const { plan } = await makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl, sleep: noWait })
    expect(plan.report?.notes.join(' ')).toContain('listener could not be run')
    expect(plan.report?.listenerFollowed).toBeNull()
  })

  it('removes spaced dashes from speech', async () => {
    const sentences = await storeDocument(fifteenPages())
    const raw = fullRawPlan(sentences)
    raw.steps[0].points[0].spoken = [{ text: 'One thing \u2014 and then another.', pauseBefore: false, stuckReason: '' }]
    const { plan } = await makePlan(FINGERPRINT, { fetchImpl: engineFetch(raw).fetchImpl })
    expect(plan.steps[0].points[0].spoken).toBe('One thing, and then another.')
  })

  it('reads a failed stream body as a retry, not as narration', async () => {
    const sentences = await storeDocument(fifteenPages())
    const broken = () => sseResponse(streamBody('{"nope'))
    const fake = engineFetch(fullRawPlan(sentences), { queue: { once_listen: [broken] } })
    const { plan } = await makePlan(FINGERPRINT, { fetchImpl: fake.fetchImpl, sleep: noWait })
    expect(fake.named('once_listen')).toHaveLength(2)
    expect(plan.report?.listenerFollowed).toBe(true)
  })
})

describe('lints', () => {
  const lint = (text: string, ...later: string[]) =>
    lintNarration([{ pointId: 'pt1', text }, ...later.map((entry, index) => ({ pointId: `pt${index + 2}`, text: entry }))]).map((entry) => entry.kind)

  it('finds letter variables and leaves ordinary letters alone', () => {
    expect(lint('Word number t waits for word number d.')).toEqual(['letter-variable', 'letter-variable'])
    expect(lint('It grows with N squared.')).toContain('letter-variable')
    expect(lint("It's a C major chord, Plan B, and the U.S. can't do x-rays.")).toEqual([])
  })

  it('finds forward references and signposts', () => {
    for (const text of ['We will come back to this later.', 'Do not worry about that word for now.', "Next, let's look at the second part.", 'There are three things to learn.', 'This matters later.', 'This is the important part.']) {
      expect(lint(text)).toContain('signpost')
    }
    expect(lint('Three years later the shop closed.')).toEqual([])
  })

  it('finds talk about the text itself', () => {
    expect(lint('This section covers the method.')).toContain('describes-the-text')
    expect(lint('The rest of the paper shows results.')).toContain('describes-the-text')
    expect(lint('The authors then describe a test.')).toContain('describes-the-text')
    expect(lint('The court said no.')).toEqual([])
  })

  it('finds formula talk', () => {
    expect(lint('The cost is proportional to the sentence length.')).toContain('formula-talk')
    expect(lint('It is the square root of the size.')).toContain('formula-talk')
    expect(lint('Forty words take forty steps.')).toEqual([])
  })

  it('finds a stated name never used again', () => {
    expect(lint('Lawyers call this strict scrutiny, and that was that.', 'The town lost.')).toContain('unused-name')
    expect(lint('Lawyers call it strict scrutiny.', 'Under strict scrutiny the town lost.')).toEqual([])
  })

  it('finds what cannot be read aloud', () => {
    expect(lint('Here is **bold** text.')).toContain('markup')
    expect(lint('See s12 for that.')).toContain('markup')
  })
})

describe('outline shape', () => {
  const sentences = Array.from({ length: 400 }, (_, i) => ({ id: `s${i + 1}` })) as never[]
  it('sends back too few sections for a long text and accepts enough', () => {
    expect(outlineShapeProblems({ sections: [{}, {}] } as never, sentences).join(' ')).toMatch(/at least 5 sections/)
    expect(outlineShapeProblems({ sections: [{}, {}, {}, {}, {}] } as never, sentences)).toEqual([])
  })
})
