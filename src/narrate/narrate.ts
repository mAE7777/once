import { createHash } from 'node:crypto'
import { viewStoredPlan } from '@/deepread/deepread'
import { OnceError } from '@/errors/errors'
import { flattenPoints } from '@/reader/state'
import { getArtifact, putArtifact, readArtifact } from '@/store/store'
import { isVoicedPoint } from './range'
import { pointDurationSeconds, type CharacterAlignment } from './timeline'

export const VOICE_ID = 'Xb7hH8MSUJpSbSDYk0k2'
export const SPEECH_MODEL_ID = 'eleven_multilingual_v2'

export function speechCacheKey(text: string, voiceId: string, modelId: string): string {
  return createHash('sha256').update(`${voiceId}\n${modelId}\n${text}`).digest('hex')
}

export interface SpeechForPointInput { fingerprint: string; pointId: string; fetchImpl?: typeof fetch }

export interface SpeechResult {
  pointId: string
  text: string
  sentenceIds: string[]
  audioBase64: string
  alignment: CharacterAlignment
  voiceId: string
  modelId: string
  durationSec: number
  cached: boolean
}

interface StoredSpeech {
  audioBase64: string
  alignment: CharacterAlignment
  voiceId: string
  modelId: string
}

function isAlignment(value: unknown): value is CharacterAlignment {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return (
    Array.isArray(item.characters) &&
    Array.isArray(item.character_start_times_seconds) &&
    Array.isArray(item.character_end_times_seconds)
  )
}

export async function speechForPoint(input: SpeechForPointInput): Promise<SpeechResult> {
  const view = await viewStoredPlan(input.fingerprint)
  if (!view.stored) {
    throw new OnceError(404, 'No explanation has been generated for this text yet.')
  }
  const flat = flattenPoints(view.stored.plan)
  const entry = flat.find((item) => item.point.id === input.pointId)
  if (!entry) {
    throw new OnceError(404, 'That point was not found in this explanation.')
  }
  const points = flat.map((item) => item.point)
  const { voicedSectionIds } = await import('./range'); const sectionIds = new Set(voicedSectionIds(input.fingerprint, view.stored.plan.steps)); const voiced = flat.filter(i=>sectionIds.has(i.step.id)).map(i=>i.point.id); if (!voiced.includes(input.pointId) && !isVoicedPoint(input.fingerprint, points, input.pointId)) {
    throw new OnceError(403, 'Voice ends here; the rest continues as text.')
  }

  const text = entry.point.spoken
  const key = speechCacheKey(text, VOICE_ID, SPEECH_MODEL_ID)
  const existing = getArtifact(input.fingerprint, 'speech', key)
  if (existing) {
    try {
      const stored = JSON.parse(readArtifact(existing.path).toString('utf8')) as StoredSpeech
      if (typeof stored.audioBase64 === 'string' && isAlignment(stored.alignment)) {
        return {
          pointId: input.pointId,
          text,
          sentenceIds: [...entry.point.sentenceIds],
          audioBase64: stored.audioBase64,
          alignment: stored.alignment,
          voiceId: VOICE_ID,
          modelId: SPEECH_MODEL_ID,
          durationSec: pointDurationSeconds(stored.alignment),
          cached: true,
        }
      }
    } catch {
      // A damaged cache entry is rebuilt below.
    }
  }

  const apiKey = process.env.ELEVENLABS_API_KEY
  if (!apiKey) {
    throw new OnceError(
      503,
      'ELEVENLABS_API_KEY is not set, so speech cannot be generated. Add it to the environment and try again.',
    )
  }

  const fetchImpl = input.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetchImpl(
      `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/with-timestamps`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          text,
          model_id: SPEECH_MODEL_ID,
          voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        }),
      },
    )
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'network error'
    throw new OnceError(502, `ElevenLabs speech could not be reached: ${detail}`)
  }

  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).trim().slice(0, 300)
    throw new OnceError(
      502,
      detail
        ? `ElevenLabs speech failed (${response.status}): ${detail}`
        : `ElevenLabs speech failed (${response.status}).`,
    )
  }

  const body = (await response.json().catch(() => null)) as {
    audio_base64?: unknown
    alignment?: unknown
  } | null
  if (!body || typeof body.audio_base64 !== 'string' || !isAlignment(body.alignment)) {
    throw new OnceError(502, 'ElevenLabs speech returned no usable audio or timing.')
  }

  const stored: StoredSpeech = {
    audioBase64: body.audio_base64,
    alignment: body.alignment,
    voiceId: VOICE_ID,
    modelId: SPEECH_MODEL_ID,
  }
  putArtifact({
    fingerprint: input.fingerprint,
    kind: 'speech',
    key,
    model: SPEECH_MODEL_ID,
    promptVersion: VOICE_ID,
    data: Buffer.from(JSON.stringify(stored), 'utf8'),
  })

  return {
    pointId: input.pointId,
    text,
    sentenceIds: [...entry.point.sentenceIds],
    audioBase64: stored.audioBase64,
    alignment: stored.alignment,
    voiceId: VOICE_ID,
    modelId: SPEECH_MODEL_ID,
    durationSec: pointDurationSeconds(stored.alignment),
    cached: false,
  }
}
