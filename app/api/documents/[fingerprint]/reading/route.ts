import { viewStoredPlan } from '@/deepread/deepread'
import { toErrorResponse } from '@/errors/errors'
import { makeSentences } from '@/sentences/sentences'
import { verifyOriginal, verifyPlan } from '@/verify/verify'
export const runtime = 'nodejs'
export async function GET(_request: Request, context: { params: Promise<{ fingerprint: string }> }): Promise<Response> {
  const { fingerprint } = await context.params
  try { await verifyOriginal(fingerprint); const view = await viewStoredPlan(fingerprint); if (!view.stored) return Response.json({ fingerprint, generated: false, message: 'No plan has been generated for this text yet.' }); const { sentences } = await makeSentences(fingerprint); const { plan, report } = verifyPlan(view.stored.plan, sentences); return Response.json({ fingerprint, generated: true, isCurrent: view.stored.isCurrent, plan, report }) } catch (error) { const { status, body } = toErrorResponse(error); return Response.json(body, { status }) }
}
