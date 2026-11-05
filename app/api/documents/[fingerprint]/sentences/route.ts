import { toErrorResponse } from '@/errors/errors'
import { makeSentences } from '@/sentences/sentences'

export const runtime = 'nodejs'

export async function POST(
  _request: Request,
  context: { params: Promise<{ fingerprint: string }> },
): Promise<Response> {
  const { fingerprint } = await context.params
  try {
    const document = await makeSentences(fingerprint)
    return Response.json({
      fingerprint: document.fingerprint,
      sentenceCount: document.sentences.length,
    })
  } catch (error) {
    const { status, body } = toErrorResponse(error)
    return Response.json(body, { status })
  }
}
