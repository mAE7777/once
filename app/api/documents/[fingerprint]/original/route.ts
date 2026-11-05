import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { toErrorResponse } from '@/errors/errors'
import { getDocument } from '@/store/store'

export const runtime = 'nodejs'

const CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  text: 'text/plain; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  url: 'text/plain; charset=utf-8',
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ fingerprint: string }> },
): Promise<Response> {
  const { fingerprint } = await context.params
  try {
    if (!/^[0-9a-f]{64}$/i.test(fingerprint)) {
      return Response.json({ error: 'This text could not be found.' }, { status: 404 })
    }
    const doc = getDocument(fingerprint)
    if (doc?.kind === 'url') {
      return Response.json(
        { error: 'Link texts keep no stored original file.' },
        { status: 404 },
      )
    }
    const bytes = await readFile(path.join(process.cwd(), 'data', 'originals', fingerprint))
    const contentType = CONTENT_TYPES[doc?.kind ?? 'text'] ?? 'application/octet-stream'
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'private, no-store',
        'Content-Length': String(bytes.length),
      },
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return Response.json({ error: 'This text could not be found.' }, { status: 404 })
    }
    const { status, body } = toErrorResponse(error)
    return Response.json(body, { status })
  }
}
