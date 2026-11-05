import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readWavInfo, transcribeAudio } from './transcribe'
import { encodeWav } from './wav'
import { POST } from '../../app/api/documents/[fingerprint]/transcribe/route'

const speech = (rate = 24000) => encodeWav(new Float32Array(rate).fill(0.25), rate)
function header(options: { format?: number; channels?: number; rate?: number; bits?: number }): Uint8Array {
  const wav = speech()
  const view = new DataView(wav.buffer)
  if (options.format !== undefined) view.setUint16(20, options.format, true)
  if (options.channels !== undefined) view.setUint16(22, options.channels, true)
  if (options.rate !== undefined) view.setUint32(24, options.rate, true)
  if (options.bits !== undefined) view.setUint16(34, options.bits, true)
  return wav
}
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => { process.env.META_API_KEY = 'test-key' })
afterEach(() => { vi.unstubAllGlobals() })

describe('readWavInfo', () => {
  it('reads rate and length from a mono 16-bit file', () => {
    expect(readWavInfo(speech())).toEqual({ sampleRate: 24000, durationMs: 1000 })
    expect(readWavInfo(speech(16000))).toEqual({ sampleRate: 16000, durationMs: 1000 })
  })
  it('walks past extra chunks before the data', () => {
    const wav = speech()
    const extra = new Uint8Array(wav.length + 12)
    extra.set(wav.slice(0, 36)); extra.set([0x4c, 0x49, 0x53, 0x54, 4, 0, 0, 0, 1, 2, 3, 4], 36); extra.set(wav.slice(36), 48)
    expect(readWavInfo(extra).durationMs).toBe(1000)
  })
  it.each([
    ['webm', new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])],
    ['stereo', header({ channels: 2 })],
    ['44.1 kHz', header({ rate: 44100 })],
    ['8-bit', header({ bits: 8 })],
    ['float', header({ format: 3 })],
  ])('refuses %s', (_name, audio) => { expect(() => readWavInfo(audio)).toThrow(expect.objectContaining({ status: 400 })) })
})

describe('transcribeAudio', () => {
  it('posts the WAV and the settings to the file endpoint and returns the transcript', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, _init?: RequestInit) => reply({ sessionId: 's', transcript: ' hello there ', audioDurationMs: 1000, turns: [] }))
    await expect(transcribeAudio(speech(), fetchImpl as unknown as typeof fetch)).resolves.toEqual({ text: 'hello there' })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://api.meta.ai/v1/asr/transcribe')
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer test-key')
    const form = init?.body as FormData
    const settings = form.get('request') as Blob
    expect(settings.type).toBe('application/json')
    expect(JSON.parse(await settings.text())).toEqual({ model: 'muse-voice-transcribe-1.0', audioEncoding: 'WAV', languageBias: ['English'] })
    const audio = form.get('audio') as File
    expect(audio.type).toBe('audio/wav')
    expect(new Uint8Array(await audio.arrayBuffer())).toEqual(speech())
  })
  it.each([
    ['nothing', new Uint8Array()],
    ['a non-WAV recording', new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])],
    ['a header with no samples', encodeWav(new Float32Array(), 24000)],
    ['more than ten minutes', encodeWav(new Float32Array(16000 * 601), 16000)],
  ])('stops %s before any paid call', async (_name, audio) => {
    const fetchImpl = vi.fn()
    await expect(transcribeAudio(audio, fetchImpl as unknown as typeof fetch)).rejects.toMatchObject({ status: 400 })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it('says nothing was heard for an empty transcript', async () => {
    await expect(transcribeAudio(speech(), (async () => reply({ transcript: '' })) as unknown as typeof fetch)).rejects.toThrow('Nothing could be heard')
  })
  it('reports an upstream refusal and a network failure as a 502', async () => {
    await expect(transcribeAudio(speech(), (async () => reply({ error: {} }, 400)) as unknown as typeof fetch)).rejects.toMatchObject({ status: 502 })
    await expect(transcribeAudio(speech(), (async () => { throw new Error('offline') }) as unknown as typeof fetch)).rejects.toMatchObject({ status: 502 })
  })
})

describe('transcribe route', () => {
  const call = (blob: Blob, name: string) => { const form = new FormData(); form.set('audio', blob, name); return POST(new Request('http://once.test/x', { method: 'POST', body: form }), { params: Promise.resolve({ fingerprint: 'f' }) }) }
  it('returns the words for a WAV', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({ transcript: 'the words' })))
    const res = await call(new Blob([new Uint8Array(speech())], { type: 'audio/wav' }), 'answer.wav')
    expect(res.status).toBe(200); expect(await res.json()).toEqual({ text: 'the words' })
  })
  it('refuses webm without calling the service', async () => {
    const fake = vi.fn(); vi.stubGlobal('fetch', fake)
    const res = await call(new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])], { type: 'audio/webm' }), 'answer.webm')
    expect(res.status).toBe(400); expect(fake).not.toHaveBeenCalled()
  })
})
