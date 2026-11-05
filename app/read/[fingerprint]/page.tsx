import Link from 'next/link'
import { makeReadable } from '@/readable/readable'
import { makeSentences, sentencesForDrawing } from '@/sentences/sentences'
import { getDocument } from '@/store/store'
import { Reader } from '@/reader/Reader'
import { strings } from '@/ui/strings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export default async function ReadPage({ params }: { params: Promise<{ fingerprint: string }> }) {
  const { fingerprint } = await params
  try {
    const readable = await makeReadable(fingerprint)
    const sentenceDoc = await makeSentences(fingerprint)
    const doc = getDocument(fingerprint)
    return (
      <Reader
        fingerprint={fingerprint}
        kind={doc?.kind ?? readable.kind}
        filename={doc?.filename || readable.kind}
        sentences={sentencesForDrawing(sentenceDoc.sentences)}
        pages={readable.pages.map((page) => ({ page: page.page, width: page.width, height: page.height, text: page.text, isScan: page.isScan }))}
      />
    )
  } catch {
    return (
      <main style={{ minHeight: '100vh', padding: '0 20px' }}>
        <header style={{ height: 'var(--topbar)', display: 'flex', alignItems: 'center' }}>
          <Link href="/" style={{ fontSize: 'var(--fs-title)', fontWeight: 600, color: 'var(--moss)', textDecoration: 'none' }}>{strings.appName}</Link>
        </header>
        <div className="sheet sheet-settle" style={{ width: 'min(560px, 100%)', margin: '12vh auto 0', padding: '24px 26px', lineHeight: 1.6 }}>
          This text is not ready to open yet. Go back, open it from your library, and it will get ready there.
        </div>
      </main>
    )
  }
}
