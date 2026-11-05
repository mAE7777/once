import { figureForPoint } from '@/figures/figures'
import { toErrorResponse } from '@/errors/errors'
export const runtime = 'nodejs'
export async function GET(request: Request, c: { params: Promise<{ fingerprint: string }> }): Promise<Response> { const { fingerprint } = await c.params; try { const point = new URL(request.url).searchParams.get('point') ?? ''; const result = await figureForPoint(fingerprint, point); if (!result) return Response.json({ found: false }); return Response.json({ found: true, ...result }) } catch (e) { const { status, body } = toErrorResponse(e); return Response.json(body, { status }) } }
