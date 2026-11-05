import {
  assertSentencesExist,
  readJsonObject,
  readerIdFrom,
  respond,
  respondWithError,
} from '@/traces/http'
import {
  TraceInputError,
  isSentenceState,
  markSentences,
  parseSentenceIds,
} from '@/traces/traces'

export const runtime = 'nodejs'

export async function POST(
  request: Request,
  context: { params: Promise<{ fingerprint: string }> },
): Promise<Response> {
  const { fingerprint } = await context.params
  try {
    const readerId = readerIdFrom(request)
    const body = await readJsonObject(request)
    if (!isSentenceState(body.state)) {
      throw new TraceInputError('That is not a sentence state.')
    }
    if (body.state !== 'explained') {
      throw new TraceInputError('Only explained can be marked here.')
    }
    const sentenceIds = parseSentenceIds(body.sentenceIds)
    if (sentenceIds.length === 0) {
      throw new TraceInputError('Name at least one sentence to mark.')
    }
    await assertSentencesExist(fingerprint, sentenceIds)
    const states = markSentences(readerId, fingerprint, sentenceIds, body.state)
    return respond({ fingerprint, states })
  } catch (error) {
    return respondWithError(error)
  }
}
