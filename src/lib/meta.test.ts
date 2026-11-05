import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MISSING_META_API_KEY_MESSAGE,
  MetaApiError,
  metaResponses,
  responseText,
} from './meta'

const originalKey = process.env.META_API_KEY

afterEach(() => {
  if (originalKey === undefined) {
    delete process.env.META_API_KEY
  } else {
    process.env.META_API_KEY = originalKey
  }
  vi.restoreAllMocks()
})

describe('metaResponses', () => {
  it('says the key is missing without calling the network when META_API_KEY is unset', async () => {
    delete process.env.META_API_KEY
    const fetchImpl = vi.fn()

    await expect(metaResponses({}, fetchImpl as unknown as typeof fetch)).rejects.toBeInstanceOf(
      MetaApiError,
    )
    await expect(metaResponses({}, fetchImpl as unknown as typeof fetch)).rejects.toThrow(
      MISSING_META_API_KEY_MESSAGE,
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('throws a typed error carrying the upstream status and message', async () => {
    process.env.META_API_KEY = 'test-key'
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: 'bad request detail' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const error = (await metaResponses({}, fetchImpl as unknown as typeof fetch).catch(
      (err) => err,
    )) as MetaApiError
    expect(error).toBeInstanceOf(MetaApiError)
    expect(error.status).toBe(400)
    expect(error.message).toBe('bad request detail')
  })
})

describe('responseText', () => {
  it('extracts text from a responses output array', () => {
    expect(
      responseText({
        output: [
          { type: 'message', content: [{ type: 'output_text', text: 'first ' }] },
          { type: 'message', content: [{ type: 'output_text', text: 'second' }] },
        ],
      }),
    ).toBe('first second')
  })

  it('extracts a plain output_text field', () => {
    expect(responseText({ output_text: 'plain text' })).toBe('plain text')
  })
})
