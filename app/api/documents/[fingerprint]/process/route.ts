import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { processState, remainingSeconds, startProcessing } from '@/ingest/process'
import { toErrorResponse } from '@/errors/errors'
export const runtime = 'nodejs'
export async function POST(_r: Request, c: { params: Promise<{ fingerprint: string }> }): Promise<Response> { const { fingerprint } = await c.params; try { return Response.json({ fingerprint, ...startProcessing(fingerprint) }) } catch (e) { const { status, body } = toErrorResponse(e); return Response.json(body, { status }) } }
export async function GET(_r: Request, c: { params: Promise<{ fingerprint: string }> }): Promise<Response> { const { fingerprint } = await c.params; const state = processState(fingerprint)
  const running = !['idle', 'done', 'failed'].includes(state.stage)
  const chars = running ? await textLength(fingerprint) : null
  return Response.json({ fingerprint, ...state, remainingSeconds: running ? remainingSeconds(state.startedAt, chars) : null }) }

async function textLength(fingerprint: string): Promise<number | null> {
  if (!/^[0-9a-f]{64}$/i.test(fingerprint)) return null
  try {
    const raw = await readFile(path.join(/*turbopackIgnore: true*/ process.cwd(), 'data', 'readable', `${fingerprint}.json`), 'utf8')
    const text = (JSON.parse(raw) as { fullText?: unknown }).fullText
    return typeof text === 'string' ? text.length : null
  } catch {
    return null
  }
}
