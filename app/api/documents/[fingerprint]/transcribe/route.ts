import { transcribeAudio } from '@/qa/transcribe'
import { toErrorResponse } from '@/errors/errors'
export const runtime = 'nodejs'
export async function POST(request: Request, c: { params: Promise<{ fingerprint: string }> }): Promise<Response> { await c.params; try { const form = await request.formData().catch(()=>null); const file = form?.get('audio'); if (!(file instanceof File)) return Response.json({ error: 'No audio was received.' }, { status: 400 }); const bytes = new Uint8Array(await file.arrayBuffer()); return Response.json(await transcribeAudio(bytes)) } catch (e) { const { status, body } = toErrorResponse(e); return Response.json(body, { status }) } }
