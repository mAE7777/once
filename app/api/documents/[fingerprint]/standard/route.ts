import { makeStandard } from '@/readable/standard'
import { toErrorResponse } from '@/errors/errors'
export const runtime = 'nodejs'
export async function GET(_r: Request, c: { params: Promise<{ fingerprint: string }> }): Promise<Response> { const { fingerprint } = await c.params; try { return Response.json(await makeStandard(fingerprint)) } catch (e) { const { status, body } = toErrorResponse(e); return Response.json(body, { status }) } }
