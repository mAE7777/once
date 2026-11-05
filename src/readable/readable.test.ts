import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ingestFile, ingestUrl } from '@/ingest/ingest'
import { MISSING_META_API_KEY_MESSAGE, MetaApiError } from '@/lib/meta'
import { DocumentNotFoundError, UrlReadableError, makeReadable } from './readable'
import { transcribePageImage } from './ocr'
import { POST } from '../../app/api/documents/[fingerprint]/readable/route'

let workDir: string
let previousCwd: string
const originalKey = process.env.META_API_KEY

beforeEach(async () => {
  previousCwd = process.cwd()
  workDir = await mkdtemp(path.join(tmpdir(), 'once-readable-'))
  process.chdir(workDir)
})

afterEach(async () => {
  process.chdir(previousCwd)
  if (originalKey === undefined) {
    delete process.env.META_API_KEY
  } else {
    process.env.META_API_KEY = originalKey
  }
  await rm(workDir, { recursive: true, force: true })
})

function articleHtml(paragraph: string, count: number): string {
  const paragraphs = Array.from({ length: count }, () => `<p>${paragraph}</p>`).join('')
  return `<!doctype html><html><head><title>A Long Article</title></head><body><article><h1>A Long Article</h1>${paragraphs}</article></body></html>`
}

async function textPdfBytes(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  page.drawText('Hello readable world', { x: 50, y: 700, size: 18, font })
  page.drawText('Second line here', { x: 50, y: 670, size: 18, font })
  return doc.save()
}

async function scanPdfBytes(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64',
  )
  const image = await doc.embedPng(new Uint8Array(png))
  page.drawImage(image, { x: 100, y: 200, width: 400, height: 400 })
  return doc.save()
}

describe('makeReadable with a text file', () => {
  it('turns a stored text file into one page and caches the result', async () => {
    const stored = await ingestFile(new TextEncoder().encode('\u7b2c\u4e00\u884c\n\u7b2c\u4e8c\u884c'), 'note.txt', 'text')

    const document = await makeReadable(stored.fingerprint)

    expect(document.fingerprint).toBe(stored.fingerprint)
    expect(document.kind).toBe('text')
    expect(document.pageCount).toBe(1)
    expect(document.fullText).toBe('\u7b2c\u4e00\u884c\n\u7b2c\u4e8c\u884c')
    expect(document.pages).toEqual([
      { page: 1, width: 0, height: 0, text: '\u7b2c\u4e00\u884c\n\u7b2c\u4e8c\u884c', items: [], isScan: false },
    ])

    const saved = await readFile(
      path.join(workDir, 'data', 'readable', `${stored.fingerprint}.json`),
      'utf8',
    )
    expect(JSON.parse(saved)).toEqual(document)

    const again = await makeReadable(stored.fingerprint)
    expect(again).toEqual(document)
  })

  it('reports an unknown fingerprint as not found', async () => {
    await expect(makeReadable('a'.repeat(64))).rejects.toBeInstanceOf(DocumentNotFoundError)
  })
})

describe('makeReadable with a link', () => {
  it('accepts a full article fetched through the injected fetch', async () => {
    const stored = await ingestUrl('https://example.com/full-article')
    const paragraph =
      'Reading carefully means following how one sentence leads to the next, keeping the thread ' +
      'of the argument in view while new details arrive and earlier claims are tested against them.'
    const html = articleHtml(paragraph, 8)
    const fetchImpl = (async () =>
      new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } })) as unknown as typeof fetch

    const document = await makeReadable(stored.fingerprint, { fetchImpl })

    expect(document.kind).toBe('url')
    expect(document.pageCount).toBe(1)
    expect(document.fullText.length).toBeGreaterThanOrEqual(800)
    expect(document.fullText).toContain('Reading carefully means following')
    expect(document.pages[0]).toMatchObject({ page: 1, width: 0, height: 0, isScan: false })
  })

  it('rejects a short paywall teaser instead of inventing the rest', async () => {
    const stored = await ingestUrl('https://example.com/paywalled')
    const html = articleHtml('Subscribe to keep reading this story.', 2)
    const fetchImpl = (async () =>
      new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } })) as unknown as typeof fetch

    await expect(makeReadable(stored.fingerprint, { fetchImpl })).rejects.toBeInstanceOf(
      UrlReadableError,
    )
  })

  it('rejects a page that answers with a non-200 status', async () => {
    const stored = await ingestUrl('https://example.com/gone')
    const fetchImpl = (async () => new Response('nope', { status: 403 })) as unknown as typeof fetch

    await expect(makeReadable(stored.fingerprint, { fetchImpl })).rejects.toBeInstanceOf(
      UrlReadableError,
    )
  })
})

describe('makeReadable with a PDF', () => {
  it('extracts known text with geometry from a generated one-page PDF', async () => {
    const stored = await ingestFile(await textPdfBytes(), 'paper.pdf', 'pdf')

    const document = await makeReadable(stored.fingerprint)

    expect(document.kind).toBe('pdf')
    expect(document.pageCount).toBe(1)
    expect(document.fullText).toContain('Hello readable world')
    expect(document.fullText).toContain('Second line here')
    expect(document.pages[0].page).toBe(1)
    expect(document.pages[0].width).toBeGreaterThan(0)
    expect(document.pages[0].height).toBeGreaterThan(0)
    expect(document.pages[0].isScan).toBe(false)
    expect(document.pages[0].items.length).toBeGreaterThan(0)
    expect(document.pages[0].items[0]).toMatchObject({ str: expect.any(String) })
    expect(document.pages[0].items[0].w).toBeGreaterThan(0)
  })

  it('sends a scan page to the model and stores the returned text', async () => {
    process.env.META_API_KEY = 'test-key'
    const stored = await ingestFile(await scanPdfBytes(), 'scan.pdf', 'pdf')
    let seenUrl = ''
    let seenInit: RequestInit | undefined
    let calls = 0
    const metaFetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls += 1
      seenUrl = String(url)
      seenInit = init
      return new Response(
        JSON.stringify({
          output: [
            {
              type: 'message',
              content: [{ type: 'output_text', text: JSON.stringify({blocks:[{text:'Words read from the scan',x:100,y:100,w:800,h:50,lines:1}]}) }],
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    const document = await makeReadable(stored.fingerprint, { metaFetchImpl })

    expect(document.pages[0].isScan).toBe(true)
    expect(document.pages[0].text).toBe('Words read from the scan')
    expect(document.pages[0].items.length).toBeGreaterThan(0)
    expect(document.pages[0].image).toBe(`data/pages/${stored.fingerprint}/p1.png`)
    const imageFile = await stat(
      path.join(workDir, 'data', 'pages', stored.fingerprint, 'p1.png'),
    )
    expect(imageFile.size).toBeGreaterThan(0)

    expect(calls).toBe(1)
    expect(seenUrl).toBe('https://api.meta.ai/v1/responses')
    expect((seenInit?.headers as Record<string, string>).Authorization).toBe('Bearer test-key')
    const sent = JSON.parse(String(seenInit?.body)) as {
      model?: string
      reasoning?: { effort?: string }
      input?: Array<{ content?: Array<Record<string, string>> }>
    }
    expect(sent.model).toBe('muse-spark-1.3')
    expect(sent.reasoning?.effort).toBe('low')
    const content = sent.input?.[0]?.content ?? []
    const imageBlock = content.find((block) => block.type === 'input_image')
    const textBlock = content.find((block) => block.type === 'input_text')
    expect(imageBlock?.image_url.startsWith('data:image/png;base64,')).toBe(true)
    expect(textBlock?.text).toContain('Transcribe this page')

    const again = await makeReadable(stored.fingerprint, { metaFetchImpl })
    expect(again).toEqual(document)
    expect(calls).toBe(1)
  })

  it('answers the readable route with counts and a 404 for unknown documents', async () => {
    const stored = await ingestFile(new TextEncoder().encode('route text body'), 'r.txt', 'text')

    const ok = await POST(new Request('http://localhost/readable', { method: 'POST' }), {
      params: Promise.resolve({ fingerprint: stored.fingerprint }),
    })
    expect(ok.status).toBe(200)
    await expect(ok.json()).resolves.toEqual({
      fingerprint: stored.fingerprint,
      pageCount: 1,
      charCount: 'route text body'.length,
      scanPages: [],
    })

    const missing = await POST(new Request('http://localhost/readable', { method: 'POST' }), {
      params: Promise.resolve({ fingerprint: 'b'.repeat(64) }),
    })
    expect(missing.status).toBe(404)
    const body = (await missing.json()) as { error?: string }
    expect(body.error).toContain('not found')
  })

  it('names the missing key when a scan needs the model', async () => {
    delete process.env.META_API_KEY
    const fetchImpl = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch

    await expect(transcribePageImage(new Uint8Array([1, 2, 3]), fetchImpl)).rejects.toBeInstanceOf(
      MetaApiError,
    )
    await expect(transcribePageImage(new Uint8Array([1, 2, 3]), fetchImpl)).rejects.toThrow(
      MISSING_META_API_KEY_MESSAGE,
    )
  })
})
