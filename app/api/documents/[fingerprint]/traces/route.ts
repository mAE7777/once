import { assertDocument, readerIdFrom, respond, respondWithError } from '@/traces/http'
import { readingState } from '@/traces/traces'

export const runtime = 'nodejs'

export async function GET(
  request: Request,
  context: { params: Promise<{ fingerprint: string }> },
): Promise<Response> {
  const { fingerprint } = await context.params
  try {
    const readerId = readerIdFrom(request)
    await assertDocument(fingerprint)
    return respond({ fingerprint, ...readingState(readerId, fingerprint) })
  } catch (error) {
    return respondWithError(error)
  }
}
