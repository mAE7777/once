import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MetaApiError, NO_UPSTREAM_STATUS, metaResponsesStream } from '@/lib/meta'
import { finalOutputText } from './deepread'
import { chunkedResponse, errorResponse, sseResponse, streamBody } from './fixtures'
import { collectCitations } from './normalize'

const originalKey = process.env.META_API_KEY
const originalModelKey = process.env.MODEL_API_KEY

beforeEach(() => {
  process.env.META_API_KEY = 'test-key'
})

afterEach(() => {
  if (originalKey === undefined) delete process.env.META_API_KEY
  else process.env.META_API_KEY = originalKey
  if (originalModelKey === undefined) delete process.env.MODEL_API_KEY
  else process.env.MODEL_API_KEY = originalModelKey
})

function returning(response: Response): typeof fetch {
  return (async () => response) as unknown as typeof fetch
}

async function failure(promise: Promise<unknown>): Promise<MetaApiError> {
  const error = await promise.then(
    () => null,
    (err: unknown) => err,
  )
  expect(error).toBeInstanceOf(MetaApiError)
  return error as MetaApiError
}

describe('metaResponsesStream', () => {
  it('asks for a stream and returns the final response from the completed event', async () => {
    let sent: Record<string, unknown> = {}
    let headers: Record<string, string> = {}
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>
      headers = init?.headers as Record<string, string>
      return sseResponse(streamBody('{"a":1}'))
    }) as unknown as typeof fetch

    const { response } = await metaResponsesStream({ model: 'm' }, fetchImpl)

    expect(sent.stream).toBe(true)
    expect(sent.model).toBe('m')
    expect(headers.Authorization).toBe('Bearer test-key')
    expect(response.status).toBe('completed')
    expect(finalOutputText(response)).toBe('{"a":1}')
  })

  it('survives events cut at any byte, including inside a multi-byte character', async () => {
    const body = new TextEncoder().encode(streamBody('{"title":"\u6ce8\u610f\u529b\u673a\u5236 🧠"}'))
    const chunks = Array.from({ length: body.length }, (_, index) => body.slice(index, index + 1))

    const { response } = await metaResponsesStream({}, returning(chunkedResponse(chunks)))

    expect(finalOutputText(response)).toBe('{"title":"\u6ce8\u610f\u529b\u673a\u5236 🧠"}')
  })

  it('reads streams that use CRLF line endings, comments and multi-line data', async () => {
    const payload = JSON.stringify({
      type: 'response.completed',
      response: { status: 'completed', output: [] },
    })
    const split = payload.indexOf(',')
    const body =
      ': keep-alive\r\n\r\n' +
      `event: response.completed\r\ndata: ${payload.slice(0, split + 1)}\r\ndata: ${payload.slice(split + 1)}\r\n\r\n`

    const { response } = await metaResponsesStream({}, returning(sseResponse(body)))

    expect(response.status).toBe('completed')
  })

  it('reads a final event that has no trailing blank line', async () => {
    const body = `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}`
    const { response } = await metaResponsesStream({}, returning(sseResponse(body)))
    expect(response.status).toBe('completed')
  })

  it('takes the event name from the event line when the data has no type', async () => {
    const body = `event: response.completed\ndata: ${JSON.stringify({ response: { status: 'completed' } })}\n\n`
    const { response } = await metaResponsesStream({}, returning(sseResponse(body)))
    expect(response.status).toBe('completed')
  })

  it('returns an incomplete response for the caller to judge rather than throwing', async () => {
    const { response } = await metaResponsesStream(
      {},
      returning(sseResponse(streamBody('{"tit', { status: 'incomplete' }))),
    )
    expect(response.status).toBe('incomplete')
    expect(response.incomplete_details).toEqual({ reason: 'max_output_tokens' })
  })

  it('throws the failure a response.failed event carries', async () => {
    const body = `event: response.failed\ndata: ${JSON.stringify({
      type: 'response.failed',
      response: { status: 'failed', error: { code: 'server_error', message: 'Model output parsing failure' } },
    })}\n\n`
    const error = await failure(metaResponsesStream({}, returning(sseResponse(body))))
    expect(error.status).toBe(NO_UPSTREAM_STATUS)
    expect(error.message).toContain('Model output parsing failure')
    expect(error.message).toContain('server_error')
  })

  it('throws on an error event, keeping a status it reports', async () => {
    const body = `event: error\ndata: ${JSON.stringify({ type: 'error', status: 429, message: 'slow down' })}\n\n`
    const error = await failure(metaResponsesStream({}, returning(sseResponse(body))))
    expect(error.status).toBe(429)
    expect(error.message).toBe('slow down')
  })

  it('reports a stream that ends without a final event', async () => {
    const body = `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: {} })}\n\n`
    const error = await failure(metaResponsesStream({}, returning(sseResponse(body))))
    expect(error.status).toBe(NO_UPSTREAM_STATUS)
    expect(error.message).toContain('closed the stream')
  })

  it('reports a connection that drops mid-stream', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new TypeError('terminated'))
      },
    })
    const error = await failure(metaResponsesStream({}, returning(new Response(stream))))
    expect(error.status).toBe(NO_UPSTREAM_STATUS)
    expect(error.message).toContain('terminated')
  })

  it('reports a connection that never opens', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    const error = await failure(metaResponsesStream({}, fetchImpl))
    expect(error.status).toBe(NO_UPSTREAM_STATUS)
    expect(error.message).toContain('fetch failed')
  })

  it('throws with the upstream status and message on an HTTP error', async () => {
    const error = await failure(
      metaResponsesStream({}, returning(errorResponse(400, 'schema not allowed'))),
    )
    expect(error.status).toBe(400)
    expect(error.message).toBe('schema not allowed')
  })

  it('says the key is missing, in English, without calling the network', async () => {
    delete process.env.META_API_KEY
    delete process.env.MODEL_API_KEY
    const fetchImpl = vi.fn()
    const error = await failure(metaResponsesStream({}, fetchImpl as unknown as typeof fetch))
    expect(error.status).toBe(0)
    expect(error.message).toContain('META_API_KEY is not set')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('finalOutputText', () => {
  it('skips the commentary messages written between searches', async () => {
    const { response } = await metaResponsesStream(
      {},
      returning(
        sseResponse(streamBody('{"answer":true}', { results: [{ url: 'https://a.example', title: 'A' }] })),
      ),
    )
    expect(finalOutputText(response)).toBe('{"answer":true}')
  })

  it('is empty when the response has no answer message', () => {
    expect(finalOutputText({ output: [{ type: 'reasoning' }] })).toBe('')
    expect(finalOutputText({})).toBe('')
  })
})

describe('collectCitations', () => {
  it('gathers addresses from search results and annotations, but not pages the model merely opened', async () => {
    const { response } = await metaResponsesStream(
      {},
      returning(
        sseResponse(
          streamBody('{}', {
            results: [{ url: 'https://results.example/a', title: 'Result' }],
            annotations: [{ url: 'https://annotated.example/b', title: 'Annotated' }],
          }),
        ),
      ),
    )
    expect(collectCitations(response)).toEqual([
      { url: 'https://results.example/a', title: 'Result' },
      { url: 'https://annotated.example/b', title: 'Annotated' },
    ])
  })
})
