import { afterEach, describe, expect, it } from 'vitest'
import { IngestError } from '@/ingest/ingest'
import { MISSING_META_API_KEY_MESSAGE, MetaApiError } from '@/lib/meta'
import { DocumentNotFoundError, ReadableError } from '@/readable/readable'
import { PdfReadableError } from '@/readable/pdf'
import { UrlReadableError } from '@/readable/url'
import { ReadableNotBuiltError, SentenceDocumentNotFoundError } from '@/sentences/sentences'
import { GET } from '../../app/api/health/route'
import { OnceError, UNKNOWN_ERROR_MESSAGE, missingKeyError, toErrorResponse } from './errors'
import { getKeyHealth } from './health'

const ENV_KEYS = ['META_API_KEY', 'MODEL_API_KEY', 'ELEVENLABS_API_KEY'] as const
const originalEnv: Record<string, string | undefined> = {}

for (const key of ENV_KEYS) {
  originalEnv[key] = process.env[key]
}

function clearKeys() {
  for (const key of ENV_KEYS) {
    delete process.env[key]
  }
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
})

describe('toErrorResponse', () => {
  it('maps a OnceError to its own status and message', () => {
    expect(toErrorResponse(new OnceError(418, 'This request cannot be handled.'))).toEqual({
      status: 418,
      body: { error: 'This request cannot be handled.' },
    })
  })

  it('maps a MetaApiError to 502 with the upstream status and message', () => {
    const result = toErrorResponse(new MetaApiError(429, 'rate limit exceeded'))
    expect(result.status).toBe(502)
    expect(result.body.error).toContain('429')
    expect(result.body.error).toContain('rate limit exceeded')
  })

  it('never includes key material in a MetaApiError response', () => {
    process.env.META_API_KEY = 'fake-key-for-test'
    const result = toErrorResponse(
      new MetaApiError(401, 'invalid credential fake-key-for-test Bearer fake-key-for-test'),
    )
    expect(result.status).toBe(502)
    expect(result.body.error).not.toContain('fake-key-for-test')
  })

  it('shows the missing-key instruction as-is for a MetaApiError with status 0', () => {
    const result = toErrorResponse(new MetaApiError(0, MISSING_META_API_KEY_MESSAGE))
    expect(result.status).toBe(503)
    expect(result.body.error).toBe(MISSING_META_API_KEY_MESSAGE)
    expect(result.body.error).toContain('.env.local')
    expect(result.body.error).not.toContain('status 0')
  })

  it('keeps the ingest status and message', () => {
    expect(toErrorResponse(new IngestError('This file is empty. Choose a file that has content.'))).toEqual({
      status: 400,
      body: { error: 'This file is empty. Choose a file that has content.' },
    })
  })

  it('keeps the readable statuses and messages', () => {
    expect(toErrorResponse(new DocumentNotFoundError())).toEqual({
      status: 404,
      body: { error: 'This document was not found.' },
    })
    expect(toErrorResponse(new ReadableError('This link record is incomplete, so the web page cannot be opened.'))).toEqual({
      status: 422,
      body: { error: 'This link record is incomplete, so the web page cannot be opened.' },
    })
    expect(toErrorResponse(new PdfReadableError('Page 2 cannot be read.'))).toEqual({
      status: 422,
      body: { error: 'Page 2 cannot be read.' },
    })
    expect(toErrorResponse(new UrlReadableError('The web page could not be opened.'))).toEqual({
      status: 422,
      body: { error: 'The web page could not be opened.' },
    })
  })

  it('keeps the sentences statuses and messages', () => {
    expect(toErrorResponse(new SentenceDocumentNotFoundError())).toEqual({
      status: 404,
      body: { error: 'This document was not found.' },
    })
    expect(toErrorResponse(new ReadableNotBuiltError())).toEqual({
      status: 409,
      body: { error: 'This document has no readable text yet. Generate the readable text first, then split it into sentences.' },
    })
  })

  it('hides internals for unknown errors', () => {
    const thrown = new Error(
      'ENOENT: no such file, open \'/Users/example/project/data/secret.json\'\n    at readFile (node:internal/fs:1:1)',
    )
    const result = toErrorResponse(thrown)
    expect(result).toEqual({ status: 500, body: { error: UNKNOWN_ERROR_MESSAGE } })
    expect(result.body.error).not.toContain(thrown.message)
    expect(result.body.error).not.toContain('/Users/')
    expect(result.body.error).not.toContain('ENOENT')
  })

  it('hides internals for non-Error values', () => {
    expect(toErrorResponse('/internal/path/boom')).toEqual({
      status: 500,
      body: { error: UNKNOWN_ERROR_MESSAGE },
    })
    expect(toErrorResponse(null)).toEqual({
      status: 500,
      body: { error: UNKNOWN_ERROR_MESSAGE },
    })
  })
})

describe('missingKeyError', () => {
  it('names META_API_KEY and .env.local, matching the meta message', () => {
    const error = missingKeyError('meta')
    expect(error).toBeInstanceOf(OnceError)
    expect(error.userMessage).toContain('META_API_KEY')
    expect(error.userMessage).toContain('.env.local')
    expect(error.userMessage).toBe(MISSING_META_API_KEY_MESSAGE)
  })

  it('names ELEVENLABS_API_KEY and .env.local', () => {
    const error = missingKeyError('elevenLabs')
    expect(error.userMessage).toContain('ELEVENLABS_API_KEY')
    expect(error.userMessage).toContain('.env.local')
  })
})

describe('key health', () => {
  it('reports false for both keys when nothing is set', () => {
    clearKeys()
    expect(getKeyHealth()).toEqual({ metaKey: false, elevenLabsKey: false })
  })

  it('reports true when META_API_KEY and ELEVENLABS_API_KEY are set', () => {
    clearKeys()
    process.env.META_API_KEY = 'fake-key-for-test'
    process.env.ELEVENLABS_API_KEY = 'fake-key-for-test'
    expect(getKeyHealth()).toEqual({ metaKey: true, elevenLabsKey: true })
  })

  it('falls back to MODEL_API_KEY for the meta key', () => {
    clearKeys()
    process.env.MODEL_API_KEY = 'fake-key-for-test'
    expect(getKeyHealth()).toEqual({ metaKey: true, elevenLabsKey: false })
  })

  it('the health route returns booleans only, with no key values', async () => {
    clearKeys()
    process.env.META_API_KEY = 'fake-key-for-test'
    const response = GET()
    const text = await response.text()
    const body = JSON.parse(text) as Record<string, unknown>
    expect(body).toEqual({ metaKey: true, elevenLabsKey: false })
    expect(Object.keys(body).sort()).toEqual(['elevenLabsKey', 'metaKey'])
    expect(text).not.toContain('fake-key-for-test')
  })

  it('the health route reports false when the keys are removed', async () => {
    clearKeys()
    const body = (await GET().json()) as Record<string, unknown>
    expect(body).toEqual({ metaKey: false, elevenLabsKey: false })
  })
})
