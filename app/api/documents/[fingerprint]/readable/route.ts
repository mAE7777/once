import { toErrorResponse } from '@/errors/errors'
import { makeReadable } from '@/readable/readable'

export const runtime = 'nodejs'

export async function POST(
  _request: Request,
  context: { params: Promise<{ fingerprint: string }> },
): Promise<Response> {
  const { fingerprint } = await context.params
  try {
    const document = await makeReadable(fingerprint)
    return Response.json({
      fingerprint: document.fingerprint,
      pageCount: document.pageCount,
      charCount: document.fullText.length,
      scanPages: document.pages.filter((page) => page.isScan).map((page) => page.page),
    })
  } catch (error) {
    const { status, body } = toErrorResponse(error)
    return Response.json(body, { status })
  }
}
