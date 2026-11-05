import { makePlan, viewStoredPlan } from '@/deepread/deepread'
import { toErrorResponse } from '@/errors/errors'
export const runtime = 'nodejs'
export async function POST(request: Request, context: { params: Promise<{ fingerprint: string }> }): Promise<Response> {
  const { fingerprint } = await context.params
  try { const body = await request.json().catch(()=>({})) as {redo?:unknown}; const result = await makePlan(fingerprint, { redo: body.redo===true }); return Response.json({ fingerprint, isCurrent: result.isCurrent, reused: result.reused, plan: result.plan }) } catch (error) { const { status, body } = toErrorResponse(error); return Response.json(body, { status }) }
}
export async function GET(_request: Request, context: { params: Promise<{ fingerprint: string }> }): Promise<Response> {
  const { fingerprint } = await context.params
  try { const view = await viewStoredPlan(fingerprint); if (!view.stored) return Response.json({ fingerprint, generated: false, message: 'No plan has been generated for this text yet.' }); return Response.json({ fingerprint, generated: true, isCurrent: view.stored.isCurrent, plan: view.stored.plan }) } catch (error) { const { status, body } = toErrorResponse(error); return Response.json(body, { status }) }
}
