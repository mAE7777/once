import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ReadableDocument, ReadablePage, Sentence } from '@/lib/types'
import { buildSentenceDocument } from '@/sentences/sentences'
import type { RawPlan, RawPoint, RawSource } from './schema'

export const FINGERPRINT = 'a'.repeat(64)

const ORIGINAL: RawSource = { kind: 'original', url: '', title: '' }

export function textPage(page: number, text: string, extra: Partial<ReadablePage> = {}): ReadablePage {
  return { page, width: 612, height: 792, text, items: [], isScan: false, ...extra }
}

export function fifteenPages(): ReadablePage[] {
  return Array.from({ length: 15 }, (_, index) => {
    const page = index + 1
    const body = Array.from(
      { length: 4 },
      (_, line) => `Page ${page} makes claim number ${line + 1} about the method.`,
    ).join(' ')
    return textPage(page, body)
  })
}

export async function storeDocument(
  pages: ReadablePage[],
  kind: ReadableDocument['kind'] = 'pdf',
  fingerprint = FINGERPRINT,
): Promise<Sentence[]> {
  const document: ReadableDocument = {
    fingerprint,
    kind,
    pageCount: pages.length,
    fullText: pages.map((page) => page.text).join('\n'),
    pages,
  }
  const sentences = buildSentenceDocument(document)
  const data = path.join(process.cwd(), 'data')
  await mkdir(path.join(data, 'readable'), { recursive: true })
  await mkdir(path.join(data, 'sentences'), { recursive: true })
  await writeFile(path.join(data, 'readable', `${fingerprint}.json`), JSON.stringify(document))
  await writeFile(path.join(data, 'sentences', `${fingerprint}.json`), JSON.stringify(sentences))
  return sentences.sentences
}

export function rawPoint(sentences: readonly Sentence[], overrides: Partial<RawPoint> = {}): RawPoint {
  return {
    spoken: [
      { text: 'People were doing this by hand. ', pauseBefore: false, stuckReason: '' },
      { text: 'Attention means looking back.', pauseBefore: true, stuckReason: 'New word.' },
    ],
    quotes: sentences.map((sentence) => ({ sentenceId: sentence.id, quote: sentence.text })),
    source: ORIGINAL,
    figurePages: [],
    figurePart: { page: 0, hasRegion: false, region: {x:0,y:0,w:0,h:0}, concept: '' },
    ...overrides,
  }
}

/** A plan covering every sentence, with the last page marked skippable as one range. */
export function fullRawPlan(sentences: readonly Sentence[]): RawPlan {
  const lastPage = sentences[sentences.length - 1].page
  const explained = sentences.filter((sentence) => sentence.page !== lastPage)
  const skipped = sentences.filter((sentence) => sentence.page === lastPage)
  const chunk = Math.ceil(explained.length / 5)
  const slice = (index: number) => {
    const part = explained.slice(index * chunk, (index + 1) * chunk)
    return part.length > 0 ? part : explained.slice(0, 1)
  }
  const kinds = ['context', 'problem', 'attempts', 'answer', 'applications'] as const
  return {
    title: 'A plain title',
    steps: kinds.map((kind, index) => ({
      kind,
      title: `The ${kind}`,
      points: [rawPoint(slice(index))],
    })),
    skippable: [
      {
        fromSentenceId: skipped[0].id,
        toSentenceId: skipped[skipped.length - 1].id,
        reason: 'Reference list.',
      },
    ],
    questions: [{ afterPointIndex: 1, question: 'You have ten words to translate and memory is tight. What breaks first and why?', guidance: 'A strong answer works out that memory runs out, and says this holds for long input but not short input.', earnsSentenceIds: slice(0).slice(0,1).map(s=>s.id) }],
    pageNotes: explained.slice(0,2).map(s=>({ sentenceId: s.id, anchor: s.text.split(' ').slice(0,2).join(' '), note: 'A short plain note.' })),
    figures: [{ page: 2, label: 'Figure 1', description: 'Boxes joined by arrows.' }],
  }
}

function sseBlock(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ ...payload, type })}\n\n`
}

export const DEFAULT_USAGE = {
  input_tokens: 1000,
  input_tokens_details: { cached_tokens: 100 },
  output_tokens: 500,
  output_tokens_details: { reasoning_tokens: 200 },
  total_tokens: 1500,
}

export interface StreamOptions {
  status?: 'completed' | 'incomplete'
  reason?: string
  annotations?: { url: string; title: string }[]
  results?: { url: string; title: string }[]
  usage?: Record<string, unknown>
}

/**
 * The event stream the API sends for a response with structured output and web search,
 * including the commentary messages it writes between tool calls.
 */
export function streamBody(outputText: string, options: StreamOptions = {}): string {
  const status = options.status ?? 'completed'
  const annotations = (options.annotations ?? []).map((link) => ({
    type: 'url_citation',
    start_index: 0,
    end_index: 10,
    ...link,
  }))
  const output: Record<string, unknown>[] = [{ id: 'rs_1', type: 'reasoning', status: 'completed', summary: [] }]
  if (options.results) {
    output.push({
      id: 'rs_2',
      type: 'message',
      role: 'assistant',
      phase: 'commentary',
      status: 'completed',
      content: [{ type: 'output_text', annotations: [], logprobs: [], text: "I'll search for that." }],
    })
    output.push({
      id: 'ws_1',
      type: 'web_search_call',
      status: 'completed',
      action: { type: 'search', query: 'q', queries: ['q'] },
      results: options.results.map((link) => ({ type: 'text_result', snippet: '', ...link })),
    })
    output.push({
      id: 'ws_2',
      type: 'web_search_call',
      status: 'completed',
      action: { type: 'open_page', url: 'https://opened.example/page' },
      results: [],
    })
  }
  output.push({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', annotations, logprobs: [], text: outputText }],
  })

  const response = {
    id: 'resp_1',
    object: 'response',
    status,
    error: null,
    incomplete_details: status === 'incomplete' ? { reason: options.reason ?? 'max_output_tokens' } : null,
    output,
    usage: options.usage ?? DEFAULT_USAGE,
  }
  const middle = Math.floor(outputText.length / 2)
  return [
    sseBlock('response.created', { response: { ...response, status: 'in_progress', output: [] }, sequence_number: 0 }),
    sseBlock('response.in_progress', { response: { ...response, status: 'in_progress', output: [] }, sequence_number: 1 }),
    'event: keepalive\ndata: {"type": "keepalive", "sequence_number": 2}\n\n',
    sseBlock('response.output_text.delta', { delta: outputText.slice(0, middle), output_index: 1, content_index: 0 }),
    sseBlock('response.output_text.delta', { delta: outputText.slice(middle), output_index: 1, content_index: 0 }),
    sseBlock('response.output_text.done', { text: outputText, output_index: 1, content_index: 0 }),
    sseBlock(status === 'completed' ? 'response.completed' : 'response.incomplete', { response }),
    'data: [DONE]\n\n',
  ].join('')
}

export function sseResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

export function chunkedResponse(chunks: Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

export function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export interface FakeFetch {
  fetchImpl: typeof fetch
  bodies: Record<string, unknown>[]
  callCount: () => number
}

/** Answers each call with the next response in the queue and records what was sent. */
export function fakeFetch(...responses: (() => Response)[]): FakeFetch {
  const bodies: Record<string, unknown>[] = []
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    const next = responses[bodies.length - 1]
    if (!next) throw new Error(`unexpected model call number ${bodies.length}`)
    return next()
  }) as unknown as typeof fetch
  return { fetchImpl, bodies, callCount: () => bodies.length }
}

export function planResponse(raw: unknown, options: StreamOptions = {}): () => Response {
  return () => sseResponse(streamBody(JSON.stringify(raw), options))
}

export const UNDERSTANDING = {
  title: 'A plain title',
  problemMap: {
    whoAndWhere: 'People at a desk.',
    whatTheyWereActuallyDoing: 'Doing this by hand.',
    whatBroke: 'It got too slow.',
    guessesAndTests: 'They tried a shortcut.',
    theAnswer: 'A better way.',
    howItCarriesOver: 'Other desks.',
    state: 'Slow.',
    goal: 'Fast.',
    constraint: 'One person.',
    expectation: 'It would help.',
  },
  claims: [{ claim: 'It is faster.', holdsWhen: 'Short jobs.', breaksWhen: 'Long jobs.', notCovered: '' }],
  concepts: [{ idea: 'A shortcut', plainMeaning: 'A quicker way.', prerequisites: [], takenForGranted: false, nameNeeded: false }],
  quantities: [{ what: 'Pages', realNumber: '15', howToFeelIt: 'Count them.' }],
  researchQuestions: ['How was this done before?'],
  figures: [{ page: 2, label: 'Figure 1', description: 'Boxes joined by arrows.' }],
}

export const CLEAN_LISTENER = {
  points: [],
  retell: 'People did it by hand until it got slow, so they found a quicker way.',
  newCase: { situation: 'A kitchen.', howItApplies: 'Prep ahead.', whereItBreaks: 'A single egg.' },
  followed: true,
}

function outlineOf(raw: RawPlan) {
  return {
    title: raw.title,
    sharedFacts: ['The desk has ten letters.'],
    sections: raw.steps.map((step) => ({
      kind: step.kind,
      title: step.title,
      startsFrom: 'What broke.',
      leavesBroken: 'What is still broken.',
      situation: 'A person at a desk with ten letters.',
      analogies: [],
      quantities: [],
      boundaries: [],
      ideasGrownHere: [{ idea: `The idea of ${step.title}`, plainMeaning: 'Plain.', nameToAttach: '' }],
      sentenceRanges: step.points.flatMap((point) =>
        point.quotes.map((quote) => ({ fromSentenceId: quote.sentenceId, toSentenceId: quote.sentenceId })),
      ),
    })),
    skippable: raw.skippable,
  }
}

export interface EngineFakeOptions extends StreamOptions {
  /** Responses used first for a stage, by format name; the ordinary answer follows when they run out. */
  queue?: Record<string, (() => Response)[]>
  /** Later parts of a text split by volume. */
  moreParts?: RawPlan[]
}

export interface EngineFake extends FakeFetch {
  named: (name: string) => Record<string, unknown>[]
}

/** Answers each stage's request by its format name, built from one finished plan. */
export function engineFetch(raw: RawPlan, options: EngineFakeOptions = {}): EngineFake {
  const { queue = {}, moreParts = [], ...stream } = options
  const parts = [raw, ...moreParts]
  let currentPart = -1
  const bodies: Record<string, unknown>[] = []
  const nameOf = (body: Record<string, unknown>) =>
    ((body.text as { format: { name: string } }).format.name)
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    bodies.push(body)
    const name = nameOf(body)
    const waiting = queue[name]
    if (waiting && waiting.length > 0) return (waiting.shift() as () => Response)()
    if (name === 'once_outline') currentPart += 1
    const part = parts[Math.max(currentPart, 0)]
    const text = JSON.stringify(body.input)
    switch (name) {
      case 'once_understand':
        return sseResponse(streamBody(JSON.stringify(UNDERSTANDING)))
      case 'once_research':
        return sseResponse(streamBody(JSON.stringify({ findings: [] }), stream))
      case 'once_outline':
        return sseResponse(streamBody(JSON.stringify(outlineOf(part))))
      case 'once_section': {
        const index = Number(/Section (\d+) of \d+\. Its plan/.exec(text)?.[1]) - 1
        const step = part.steps[index]
        return sseResponse(
          streamBody(
            JSON.stringify({
              points: step.points,
              questions: index === 0 ? part.questions.map((q) => ({ afterPointInSection: q.afterPointIndex, question: q.question, guidance: q.guidance, earnsSentenceIds: q.earnsSentenceIds })) : [],
              pageNotes: index === 0 ? part.pageNotes : [],
            }),
          ),
        )
      }
      case 'once_listen':
        return sseResponse(streamBody(JSON.stringify(CLEAN_LISTENER)))
      case 'once_rewrite':
        return sseResponse(streamBody(JSON.stringify({ points: [] })))
      case 'once_plan_repair':
        return sseResponse(streamBody(JSON.stringify({ corrections: [], addedQuotes: [], addedPoints: [], addedSkippable: [] })))
      default:
        throw new Error(`unexpected model call ${name}`)
    }
  }) as unknown as typeof fetch
  return {
    fetchImpl,
    bodies,
    callCount: () => bodies.length,
    named: (name) => bodies.filter((body) => nameOf(body) === name),
  }
}
