import { missingKeyError } from '@/errors/errors'

export class MetaApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'MetaApiError'
    this.status = status
  }
}

export const MISSING_META_API_KEY_MESSAGE =
  'META_API_KEY is not set, so scanned pages cannot be read. Add META_API_KEY to the .env.local file in the project root, then restart the app and try again.'

const META_RESPONSES_URL = 'https://api.meta.ai/v1/responses'

function upstreamMessage(payload: unknown, rawText: string): string {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    const error = record.error
    if (error && typeof error === 'object') {
      const message = (error as Record<string, unknown>).message
      if (typeof message === 'string' && message.trim()) return message
    }
    if (typeof record.message === 'string' && record.message.trim()) return record.message
  }
  if (rawText.trim()) return rawText.trim()
  return 'The model service returned nothing.'
}

export async function metaResponses(
  body: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const apiKey = process.env.META_API_KEY || process.env.MODEL_API_KEY
  if (!apiKey) {
    throw new MetaApiError(0, missingKeyError('meta').userMessage)
  }

  const response = await fetchImpl(META_RESPONSES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  const rawText = await response.text()
  let parsed: unknown = null
  if (rawText) {
    try {
      parsed = JSON.parse(rawText)
    } catch {
      parsed = null
    }
  }

  if (!response.ok) {
    throw new MetaApiError(response.status, upstreamMessage(parsed, rawText))
  }
  if (parsed === null) {
    throw new MetaApiError(response.status, 'The model service returned a reply that could not be read.')
  }
  return parsed
}

// The connection itself failed, so there is no upstream HTTP status to report.
export const NO_UPSTREAM_STATUS = -1

export interface MetaStreamResult {
  response: Record<string, unknown>
}

interface SseEvent {
  event: string | null
  data: string
}

async function* readSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let event: string | null = null
  let data: string[] = []

  function takeLine(line: string): SseEvent | null {
    if (line === '') {
      const complete = data.length > 0 ? { event, data: data.join('\n') } : null
      event = null
      data = []
      return complete
    }
    if (line.startsWith(':')) return null
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    if (field === 'data') data.push(value)
    return null
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      for (;;) {
        const index = buffer.search(/\r\n|\n|\r/)
        if (index === -1) break
        // A trailing \r may be the first half of a \r\n still on its way.
        if (!done && buffer[index] === '\r' && index === buffer.length - 1) break
        const width = buffer.startsWith('\r\n', index) ? 2 : 1
        const complete = takeLine(buffer.slice(0, index))
        buffer = buffer.slice(index + width)
        if (complete) yield complete
      }
      if (done) break
    }
    if (buffer) takeLine(buffer)
    const last = takeLine('')
    if (last) yield last
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

function streamErrorDetails(payload: Record<string, unknown>): { status: number; message: string } {
  const response = payload.response as Record<string, unknown> | undefined
  const error = (response?.error ?? payload.error ?? payload) as Record<string, unknown>
  const status = typeof error.status === 'number' ? error.status : NO_UPSTREAM_STATUS
  const code = typeof error.code === 'string' ? error.code : null
  const message =
    typeof error.message === 'string' && error.message.trim()
      ? error.message
      : 'The model service reported a failure without details.'
  return { status, message: code ? `${message} (${code})` : message }
}

export async function metaResponsesStream(
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<MetaStreamResult> {
  const apiKey = process.env.META_API_KEY || process.env.MODEL_API_KEY
  if (!apiKey) {
    throw new MetaApiError(
      0,
      'META_API_KEY is not set, so the model cannot be called. Add META_API_KEY to the .env.local file in the project root and restart the app.',
    )
  }

  let response: Response
  try {
    response = await fetchImpl(META_RESPONSES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ ...body, stream: true }),
    })
  } catch (error) {
    throw new MetaApiError(
      NO_UPSTREAM_STATUS,
      `Could not reach the model service: ${(error as Error).message}`,
    )
  }

  if (!response.ok) {
    const rawText = await response.text()
    let parsed: unknown = null
    try {
      parsed = JSON.parse(rawText)
    } catch {
      parsed = null
    }
    throw new MetaApiError(response.status, upstreamMessage(parsed, rawText))
  }
  if (!response.body) {
    throw new MetaApiError(response.status, 'The model service returned an empty stream.')
  }

  try {
    for await (const { event, data } of readSseEvents(response.body)) {
      if (data === '[DONE]') continue
      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(data) as Record<string, unknown>
      } catch {
        continue
      }
      const type = typeof payload.type === 'string' ? payload.type : event
      if (type === 'response.completed' || type === 'response.incomplete') {
        return { response: payload.response as Record<string, unknown> }
      }
      if (type === 'response.failed' || type === 'error') {
        const { status, message } = streamErrorDetails(payload)
        throw new MetaApiError(status, message)
      }
    }
  } catch (error) {
    if (error instanceof MetaApiError) throw error
    throw new MetaApiError(
      NO_UPSTREAM_STATUS,
      `The connection to the model service dropped mid-stream: ${(error as Error).message}`,
    )
  }
  throw new MetaApiError(
    NO_UPSTREAM_STATUS,
    'The model service closed the stream before saying the response had finished.',
  )
}

export function responseText(json: unknown): string {
  if (!json || typeof json !== 'object') return ''
  const record = json as Record<string, unknown>

  if (typeof record.output_text === 'string') return record.output_text

  const parts: string[] = []
  const output = record.output
  if (Array.isArray(output)) {
    for (const item of output) {
      if (!item || typeof item !== 'object') continue
      const entry = item as Record<string, unknown>
      if (typeof entry.text === 'string') {
        parts.push(entry.text)
        continue
      }
      const content = entry.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (!block || typeof block !== 'object') continue
        const part = block as Record<string, unknown>
        if (typeof part.text === 'string') parts.push(part.text)
      }
    }
  }
  if (parts.length > 0) return parts.join('')

  const choices = record.choices
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      if (!choice || typeof choice !== 'object') continue
      const message = (choice as Record<string, unknown>).message
      if (message && typeof message === 'object') {
        const content = (message as Record<string, unknown>).content
        if (typeof content === 'string') parts.push(content)
      }
    }
  }
  return parts.join('')
}
