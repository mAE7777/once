import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ReadableDocument } from '@/lib/types'
import { FINGERPRINT, textPage } from './fixtures'
import {
  MAX_IMAGES_PER_CALL,
  findImagePages,
  hasFigureCaption,
  loadPageImages,
  splitIntoVolumes,
  volumeNote,
} from './pages'

let workDir: string
let previousCwd: string

beforeEach(async () => {
  previousCwd = process.cwd()
  workDir = await mkdtemp(path.join(tmpdir(), 'once-pages-'))
  process.chdir(workDir)
})

afterEach(async () => {
  process.chdir(previousCwd)
  await rm(workDir, { recursive: true, force: true })
})

function document(pages: ReadableDocument['pages'], kind: ReadableDocument['kind'] = 'pdf'): ReadableDocument {
  return { fingerprint: FINGERPRINT, kind, pageCount: pages.length, fullText: '', pages }
}

async function storeOriginal(bytes: Uint8Array): Promise<void> {
  const dir = path.join(process.cwd(), 'data', 'originals')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, FINGERPRINT), bytes)
}

// Page 1 is plain text, page 2 is a drawn figure (many separate paths), page 3 has one rule.
async function mixedPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  pdf.addPage([612, 792]).drawText('Plain words only.', { x: 50, y: 700, size: 12, font })
  const drawn = pdf.addPage([612, 792])
  for (let index = 0; index < 30; index += 1) {
    drawn.drawLine({ start: { x: 50, y: 100 + index * 10 }, end: { x: 500, y: 100 + index * 10 } })
  }
  const ruled = pdf.addPage([612, 792])
  ruled.drawLine({ start: { x: 50, y: 400 }, end: { x: 500, y: 400 } })
  return pdf.save()
}

describe('hasFigureCaption', () => {
  it('finds captions at the start of a line', () => {
    expect(hasFigureCaption('Figure 1: The Transformer.\nMore text')).toBe(true)
    expect(hasFigureCaption('Some text\nTable 2: Results')).toBe(true)
    expect(hasFigureCaption('Fig. 3 shows it')).toBe(true)
    expect(hasFigureCaption('TABLE IV\nResults')).toBe(true)
    expect(hasFigureCaption('\u6b63\u6587\n\u56fe 2 \u6a21\u578b\u7ed3\u6784')).toBe(true)
    expect(hasFigureCaption('\u88681 \u7ed3\u679c')).toBe(true)
  })

  it('ignores mentions inside a line and ordinary words', () => {
    expect(hasFigureCaption('as shown in Figure 1 above')).toBe(false)
    expect(hasFigureCaption('The table is large.\nThe figure is clear.')).toBe(false)
    expect(hasFigureCaption('The table in the text')).toBe(false)
  })
})

describe('findImagePages', () => {
  it('chooses scans, pages already holding an image, captioned pages and drawn figures', async () => {
    await storeOriginal(await mixedPdf())
    const pages = await findImagePages(
      document([textPage(1, 'Plain words only.'), textPage(2, ''), textPage(3, '')]),
    )
    expect(pages).toEqual([2])

    const flagged = await findImagePages(
      document([
        textPage(1, 'Plain.', { isScan: true }),
        textPage(2, 'Plain.', { image: 'data/pages/x/p2.png' }),
        textPage(3, 'Table 1: Results'),
      ]),
    )
    expect(flagged).toEqual([1, 2, 3])
  })

  it('sends no images for text and web articles', async () => {
    expect(await findImagePages(document([textPage(1, 'Figure 1: words')], 'text'))).toEqual([])
    expect(await findImagePages(document([textPage(1, 'Figure 1: words')], 'url'))).toEqual([])
  })
})

describe('loadPageImages', () => {
  it('renders a page with no stored image and keeps it, then reads it back', async () => {
    await storeOriginal(await mixedPdf())
    const doc = document([textPage(1, ''), textPage(2, ''), textPage(3, '')])

    const first = await loadPageImages(doc, [2])

    expect(first.missing).toEqual([])
    expect(first.images).toHaveLength(1)
    expect(first.images[0].page).toBe(2)
    expect(first.images[0].dataUrl.startsWith('data:image/png;base64,')).toBe(true)
    const stored = path.join(process.cwd(), 'data', 'pages', FINGERPRINT, 'p2.png')
    expect((await stat(stored)).size).toBeGreaterThan(0)

    await rm(path.join(process.cwd(), 'data', 'originals', FINGERPRINT))
    const second = await loadPageImages(doc, [2])
    expect(second.images[0].dataUrl).toBe(first.images[0].dataUrl)
  })

  it('reports pages it cannot produce instead of inventing them', async () => {
    const { images, missing } = await loadPageImages(document([textPage(1, '')]), [1])
    expect(images).toEqual([])
    expect(missing).toEqual([1])
  })

  it('reads an image stored by the readable step', async () => {
    const target = path.join(process.cwd(), 'data', 'pages', FINGERPRINT, 'p1.png')
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, Buffer.from([1, 2, 3]))
    const { images } = await loadPageImages(document([textPage(1, '')]), [1])
    expect(images[0].dataUrl).toBe(`data:image/png;base64,${(await readFile(target)).toString('base64')}`)
  })
})

describe('splitIntoVolumes', () => {
  const pages = (count: number) => Array.from({ length: count }, (_, i) => textPage(i + 1, 'words'))

  it('keeps one call when the caps are not reached', () => {
    const imagePages = Array.from({ length: MAX_IMAGES_PER_CALL }, (_, i) => i + 1)
    const split = splitIntoVolumes(pages(200), imagePages)
    expect(split.parts).toEqual([{ fromPage: 1, toPage: 200, imagePages }])
    expect(split.reason).toBeNull()
    expect(volumeNote(split, imagePages.length)).toBeNull()
  })

  it('splits when the image limit forces it and says so', () => {
    const imagePages = Array.from({ length: 120 }, (_, i) => i + 1)
    const split = splitIntoVolumes(pages(130), imagePages)

    expect(split.reason).toBe('image-limit')
    expect(split.parts.map((part) => part.imagePages.length)).toEqual([50, 50, 20])
    expect(split.parts.map((part) => [part.fromPage, part.toPage])).toEqual([
      [1, 50],
      [51, 100],
      [101, 130],
    ])
    expect(volumeNote(split, 120)).toContain('read in 3 parts')
  })

  it('splits when the text would not fit in the context window', () => {
    const split = splitIntoVolumes(pages(10), [], { maxTokens: 10 })
    expect(split.reason).toBe('context-limit')
    expect(split.parts.length).toBeGreaterThan(1)
    expect(split.parts[0].fromPage).toBe(1)
    expect(split.parts[split.parts.length - 1].toPage).toBe(10)
    expect(volumeNote(split, 0)).toContain('longer than one call can hold')
  })
})
