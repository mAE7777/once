import { OnceError } from '@/errors/errors'

export class TranscribeError extends OnceError { constructor(m: string) { super(502, m); this.name = 'TranscribeError' } }
export class TranscribeInputError extends OnceError { constructor(m: string) { super(400, m); this.name = 'TranscribeInputError' } }

const ASR_URL = 'https://api.meta.ai/v1/asr/transcribe'
const ASR_MODEL = 'muse-voice-transcribe-1.0'
const MAX_BYTES = 32_000_000
const MAX_AUDIO_MS = 10 * 60 * 1000
const TIMEOUT_MS = 60_000
const NOT_WAV = 'That recording is not in a format that can be transcribed. Send mono 16-bit WAV at 16 or 24 kHz.'

function fourCc(audio: Uint8Array, at: number): string {
  return String.fromCharCode(audio[at], audio[at + 1], audio[at + 2], audio[at + 3])
}

/** The speech service only takes RIFF/WAVE, mono, 16-bit PCM at 16 or 24 kHz, so anything else stops here unbilled. */
export function readWavInfo(audio: Uint8Array): { sampleRate: number; durationMs: number } {
  if (audio.length < 12 || fourCc(audio, 0) !== 'RIFF' || fourCc(audio, 8) !== 'WAVE') throw new TranscribeInputError(NOT_WAV)
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength)
  let sampleRate = 0
  for (let at = 12; at + 8 <= audio.length;) {
    const id = fourCc(audio, at)
    const size = view.getUint32(at + 4, true)
    if (id === 'fmt ' && at + 24 <= audio.length) {
      const pcm = view.getUint16(at + 8, true) === 1
      const mono = view.getUint16(at + 10, true) === 1
      const rate = view.getUint32(at + 12, true)
      const bits = view.getUint16(at + 22, true)
      if (!pcm || !mono || bits !== 16 || (rate !== 16000 && rate !== 24000)) throw new TranscribeInputError(NOT_WAV)
      sampleRate = rate
    }
    if (id === 'data') {
      if (!sampleRate) throw new TranscribeInputError(NOT_WAV)
      const bytes = Math.min(size, audio.length - at - 8)
      return { sampleRate, durationMs: (bytes / 2 / sampleRate) * 1000 }
    }
    at += 8 + size + (size % 2)
  }
  throw new TranscribeInputError(NOT_WAV)
}

/** Browser audio arrives as WAV and goes through the server to muse-voice-transcribe-1.0 on the file endpoint. */
export async function transcribeAudio(audio: Uint8Array, fetchImpl: typeof fetch = fetch): Promise<{ text: string }> {
  if (!audio.byteLength) throw new TranscribeInputError('No audio was received.')
  if (audio.byteLength > MAX_BYTES) throw new TranscribeInputError('That recording is too long to transcribe.')
  const { durationMs } = readWavInfo(audio)
  if (durationMs > MAX_AUDIO_MS) throw new TranscribeInputError('That recording is too long to transcribe.')
  if (durationMs === 0) throw new TranscribeInputError('No audio was received.')
  const key = process.env.META_API_KEY || process.env.MODEL_API_KEY
  if (!key) throw new TranscribeError('META_API_KEY is not set, so voice answers cannot be transcribed.')
  const form = new FormData()
  form.set('request', new Blob([JSON.stringify({ model: ASR_MODEL, audioEncoding: 'WAV', languageBias: ['English'] })], { type: 'application/json' }))
  form.set('audio', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'answer.wav')
  let response: Response
  try {
    response = await fetchImpl(ASR_URL, { method: 'POST', headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, body: form, signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch {
    throw new TranscribeError('Transcription could not be completed.')
  }
  if (!response.ok) throw new TranscribeError('Transcription could not be completed.')
  const json = await response.json().catch(() => null) as { transcript?: unknown } | null
  const text = typeof json?.transcript === 'string' ? json.transcript.trim() : ''
  if (!text) throw new TranscribeError('Nothing could be heard in that recording.')
  return { text }
}
