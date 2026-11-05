export interface ErrorResponse {
  status: number
  body: { error: string }
}

interface OnceErrorOptions {
  status: number
  userMessage?: string
  message?: string
}

export class OnceError extends Error {
  readonly status: number
  readonly userMessage: string

  constructor(status: number, userMessage: string)
  constructor(options: OnceErrorOptions)
  constructor(statusOrOptions: number | OnceErrorOptions, userMessage?: string) {
    const status = typeof statusOrOptions === 'number' ? statusOrOptions : statusOrOptions.status
    const message =
      typeof statusOrOptions === 'number'
        ? (userMessage ?? '')
        : (statusOrOptions.userMessage ?? statusOrOptions.message ?? '')
    super(message)
    this.name = 'OnceError'
    this.status = status
    this.userMessage = message
  }
}

export const UNKNOWN_ERROR_MESSAGE = 'Something went wrong on the server. Please try again in a moment.'

export type KeyService = 'meta' | 'elevenLabs'

function keyDetails(service: string): { envVar: string; whatFails: string } {
  const normalized = service.toLowerCase()
  if (normalized.includes('eleven')) {
    return { envVar: 'ELEVENLABS_API_KEY', whatFails: 'read-aloud audio cannot be generated' }
  }
  if (normalized.includes('meta') || normalized.includes('model')) {
    return { envVar: 'META_API_KEY', whatFails: 'scanned pages cannot be read' }
  }
  if (/^[A-Z][A-Z0-9_]*$/.test(service)) {
    return { envVar: service, whatFails: 'features that need this key cannot be used' }
  }
  return { envVar: 'META_API_KEY', whatFails: 'scanned pages cannot be read' }
}

export function missingKeyError(service: KeyService | string): OnceError {
  const { envVar, whatFails } = keyDetails(String(service))
  return new OnceError(
    503,
    `${envVar} is not set, so ${whatFails}. Add ${envVar} to the .env.local file in the project root, then restart the app and try again.`,
  )
}

const SECRET_ENV_VARS = ['META_API_KEY', 'MODEL_API_KEY', 'ELEVENLABS_API_KEY'] as const

export function redactSecrets(text: string): string {
  let redacted = text
  for (const name of SECRET_ENV_VARS) {
    const value = process.env[name]
    if (value) {
      redacted = redacted.split(value).join('***')
    }
  }
  return redacted.replace(/Bearer\s+\S+/gi, 'Bearer ***')
}

function messageOf(err: Error): string {
  const message = typeof err.message === 'string' ? err.message.trim() : ''
  return redactSecrets(message)
}

function numericStatus(err: Error): number | null {
  const status = (err as { status?: unknown }).status
  return typeof status === 'number' && Number.isFinite(status) ? status : null
}

// The existing error classes each put their class name in the name field, so the status is looked up by name.
// That way this file does not import the feature modules, which would create a circular import.
const STATUS_BY_ERROR_NAME: Record<string, number> = {
  IngestError: 400,
  DocumentNotFoundError: 404,
  SentenceDocumentNotFoundError: 404,
  ReadableNotBuiltError: 409,
  ReadableError: 422,
  PdfReadableError: 422,
  UrlReadableError: 422,
  OcrError: 422,
  SentencesError: 422,
  NonEnglishTextError: 422,
  TranscribeError: 502,
  FigureError: 502,
  ProcessingError: 409,
  PlanInputError: 422,
  PlanModelError: 502,
  PlanCoverageError: 502,
  PlanStoreError: 500,
  OriginalTamperedError: 409,
}

function metaErrorResponse(err: Error): ErrorResponse {
  const upstreamStatus = numericStatus(err)
  const upstreamMessage = messageOf(err)
  // Status 0 means no request left this machine, currently only for a missing key, so the reader gets the instruction as it is.
  if (upstreamStatus === 0) {
    return { status: 503, body: { error: upstreamMessage || UNKNOWN_ERROR_MESSAGE } }
  }
  if (upstreamStatus !== null && upstreamStatus > 0) {
    const detail = upstreamMessage
      ? `The model service call failed (status ${upstreamStatus}): ${upstreamMessage}`
      : `The model service call failed (status ${upstreamStatus}).`
    return { status: 502, body: { error: detail } }
  }
  const detail = upstreamMessage ? `The model service call failed: ${upstreamMessage}` : 'The model service call failed.'
  return { status: 502, body: { error: detail } }
}

export function toErrorResponse(err: unknown): ErrorResponse {
  if (err instanceof OnceError) {
    return { status: err.status, body: { error: redactSecrets(err.userMessage) } }
  }

  if (err instanceof Error) {
    if (err.name === 'MetaApiError') {
      return metaErrorResponse(err)
    }

    const knownStatus = STATUS_BY_ERROR_NAME[err.name]
    if (knownStatus !== undefined) {
      return { status: knownStatus, body: { error: messageOf(err) || UNKNOWN_ERROR_MESSAGE } }
    }

    const userMessage = (err as { userMessage?: unknown }).userMessage
    const status = numericStatus(err)
    if (typeof userMessage === 'string' && userMessage && status !== null && status >= 400 && status <= 599) {
      return { status, body: { error: redactSecrets(userMessage) } }
    }
  }

  return { status: 500, body: { error: UNKNOWN_ERROR_MESSAGE } }
}
