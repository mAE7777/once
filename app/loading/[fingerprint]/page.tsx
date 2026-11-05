import { LoadingScreen } from '@/ui/LoadingScreen'

export const dynamic = 'force-dynamic'

export default async function LoadingPage({ params }: { params: Promise<{ fingerprint: string }> }) {
  const { fingerprint } = await params
  return <LoadingScreen fingerprint={fingerprint} />
}
