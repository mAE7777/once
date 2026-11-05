import { OnceError, toErrorResponse } from '@/errors/errors'
import { speechForPoint } from '@/narrate/narrate'
export const runtime = 'nodejs'
export async function POST(request: Request, context: { params: Promise<{ fingerprint: string }> }): Promise<Response> { const { fingerprint } = await context.params; try { const body = await request.json().catch(()=>null) as {pointId?:unknown}|null; if (!body||typeof body.pointId!=='string'||!body.pointId) throw new OnceError(400,'A point id is required.'); return Response.json(await speechForPoint({ fingerprint, pointId: body.pointId })) } catch (e) { const { status, body } = toErrorResponse(e); return Response.json(body, { status }) } }
