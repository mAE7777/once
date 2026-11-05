import { toErrorResponse } from '@/errors/errors'
import { makeSentences } from '@/sentences/sentences'
import { TraceInputError, isReaderId } from './traces'

export const READER_HEADER = 'x-reader-id'

export function readerIdFrom(request: Request): string {
  const value = request.headers.get(READER_HEADER)
  if (!isReaderId(value)) {
    throw new TraceInputError(`The ${READER_HEADER} header is missing or malformed.`)
  }
  return value
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    throw new TraceInputError('The request body is not valid JSON.')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new TraceInputError('The request body must be a JSON object.')
  }
  return body as Record<string, unknown>
}

/** Confirms the text exists, so a mistyped fingerprint is a 404 and not an empty reading. */
export async function assertDocument(fingerprint: string): Promise<void> {
  await makeSentences(fingerprint)
}

export async function assertSentencesExist(
  fingerprint: string,
  sentenceIds: readonly string[],
): Promise<void> {
  const { sentences } = await makeSentences(fingerprint)
  const known = new Set(sentences.map((sentence) => sentence.id))
  if (sentenceIds.some((id) => !known.has(id))) {
    throw new TraceInputError('This text has no such sentence.')
  }
}

/** Replies carry one reader's data, so no cache may keep them. */
export function respond(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store' } })
}

export function respondWithError(error: unknown): Response {
  const { status, body } = toErrorResponse(error)
  return respond(body, status)
}
