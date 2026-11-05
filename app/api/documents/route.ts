import { toErrorResponse } from '@/errors/errors'
import { ingestFile, ingestText, ingestUrl, type FileDocumentKind } from '@/ingest/ingest'
import { processState } from '@/ingest/process'
import { titleForDocument } from '@/ingest/ingest'
import { backfillDocuments, listDocuments } from '@/store/store'

export const runtime = 'nodejs'

function kindFromFilename(filename: string): FileDocumentKind | null {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.pdf')) return 'pdf'
  if (lower.endsWith('.txt')) return 'text'
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.png') || lower.endsWith('.webp')) return 'image'
  return null
}

function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400 })
}

export async function GET(): Promise<Response> {
  try {
    backfillDocuments()
    const { readFile } = await import('node:fs/promises')
    const documents = await Promise.all(listDocuments().map(async (doc) => { const state = processState(doc.fingerprint); let fullText: string | null = null; try { fullText = (JSON.parse(await readFile(`data/readable/${doc.fingerprint}.json`, 'utf8')) as { fullText?: string }).fullText ?? null } catch { fullText = null } return { fingerprint: doc.fingerprint, title: titleForDocument(doc.filename, fullText, doc.sourceUrl), kind: doc.kind, processed: state.stage==='done', processing: { stage: state.stage, error: state.error }, filename: doc.filename, byteLength: doc.byteLength, sourceUrl: doc.sourceUrl, createdAt: doc.createdAt } }))
    return Response.json({ documents })
  } catch (error) {
    const { status, body } = toErrorResponse(error)
    return Response.json(body, { status })
  }
}

export async function POST(request: Request): Promise<Response> {
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return badRequest('No file or link was received. Please submit it again.')
  }

  const file = form.get('file')
  const urlField = form.get('url')
  const url = typeof urlField === 'string' ? urlField.trim() : ''

  try {
    if (file instanceof File && file.name) {
      const kind = kindFromFilename(file.name)
      if (!kind) {
        return badRequest('This file type is not supported. Upload a PDF, .txt, .md or image file.')
      }
      const bytes = new Uint8Array(await file.arrayBuffer())
      const result = await ingestFile(bytes, file.name, kind)
      return Response.json({
        fingerprint: result.fingerprint,
        kind: result.kind,
        alreadyStored: result.alreadyStored,
      })
    }

    const textField = form.get('text'); const pasted = typeof textField==='string'?textField:''
    if (pasted) { const result = await ingestText(pasted); return Response.json({ fingerprint: result.fingerprint, kind: result.kind, alreadyStored: result.alreadyStored }) }
    if (url) {
      const result = await ingestUrl(url)
      return Response.json({
        fingerprint: result.fingerprint,
        kind: result.kind,
        alreadyStored: result.alreadyStored,
      })
    }

    return badRequest('No file or link was received. Choose a file or paste a link, then submit.')
  } catch (error) {
    const { status, body } = toErrorResponse(error)
    return Response.json(body, { status })
  }
}
