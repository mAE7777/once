import { getKeyHealth } from '@/errors/health'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function GET(): Response {
  return Response.json(getKeyHealth())
}
