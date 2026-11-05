import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { getDocumentProxy, getResolvedPDFJS, renderPageAsImage } from 'unpdf'
import type { PlanPart, ReadableDocument, ReadablePage } from '@/lib/types'

export const MAX_IMAGES_PER_CALL = 50

// The context window is 1,048,576 tokens shared with max_output_tokens. Text goes in inline
// rather than as a PDF, so the API's 100-page PDF text limit does not apply; this does.
export const MAX_INPUT_TOKENS_PER_CALL = 850_000
const TOKENS_PER_IMAGE = 3_000

// Ruled tables and drawn figures show up as many path operations; a text page has a handful
// at most (fraction bars, footnote rules).
const VECTOR_PATH_THRESHOLD = 20

const FIGURE_CAPTION =
  /(?:^|\n)\s*(?:figure|fig\.?|table|tab\.|chart|scheme|\u56fe|\u8868)\s*(?:\d+|[ivxlc]+\b|[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341]+)/i

export function hasFigureCaption(text: string): boolean {
  return FIGURE_CAPTION.test(text)
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2)
}

type PdfProxy = Awaited<ReturnType<typeof getDocumentProxy>>

async function withPdf<T>(
  fingerprint: string,
  use: (proxy: PdfProxy) => Promise<T>,
): Promise<T | null> {
  let bytes: Buffer
  try {
    bytes = await readFile(path.join(process.cwd(), 'data', 'originals', fingerprint))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const proxy = await getDocumentProxy(new Uint8Array(bytes))
  try {
    return await use(proxy)
  } finally {
    await (proxy as unknown as { destroy?: () => Promise<void> }).destroy?.()
  }
}

async function pagesWithManyPaths(
  fingerprint: string,
  candidates: readonly number[],
): Promise<number[]> {
  if (candidates.length === 0) return []
  const pdfjs = (await getResolvedPDFJS()) as { OPS?: Record<string, number> }
  const constructPath = pdfjs.OPS?.constructPath
  if (constructPath === undefined) return []
  const found = await withPdf(fingerprint, async (proxy) => {
    const pages: number[] = []
    for (const pageNumber of candidates) {
      const page = await proxy.getPage(pageNumber)
      try {
        const operators = await page.getOperatorList()
        const paths = operators.fnArray.filter((code: number) => code === constructPath).length
        if (paths >= VECTOR_PATH_THRESHOLD) pages.push(pageNumber)
      } finally {
        page.cleanup()
      }
    }
    return pages
  })
  return found ?? []
}

/** Scan pages and pages carrying figures or tables, in page order. */
export async function findImagePages(document: ReadableDocument): Promise<number[]> {
  if (document.kind !== 'pdf') return []
  const chosen = new Set<number>()
  const remaining: number[] = []
  for (const page of document.pages) {
    if (page.isScan || page.image || hasFigureCaption(page.text)) chosen.add(page.page)
    else remaining.push(page.page)
  }
  for (const pageNumber of await pagesWithManyPaths(document.fingerprint, remaining)) {
    chosen.add(pageNumber)
  }
  return [...chosen].sort((a, b) => a - b)
}

export interface PageImage {
  page: number
  dataUrl: string
}

function toDataUrl(bytes: Uint8Array): string {
  return `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`
}

function pageImagePath(fingerprint: string, pageNumber: number): string {
  return path.join(process.cwd(), 'data', 'pages', fingerprint, `p${pageNumber}.png`)
}

/** Reads rendered pages, rendering the ones that have no image yet. Unrenderable pages are reported. */
export async function loadPageImages(
  document: ReadableDocument,
  pageNumbers: readonly number[],
): Promise<{ images: PageImage[]; missing: number[] }> {
  const found = new Map<number, Uint8Array>()
  const toRender: number[] = []
  for (const pageNumber of pageNumbers) {
    try {
      found.set(pageNumber, await readFile(pageImagePath(document.fingerprint, pageNumber)))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      toRender.push(pageNumber)
    }
  }

  if (toRender.length > 0) {
    await withPdf(document.fingerprint, async (proxy) => {
      for (const pageNumber of toRender) {
        try {
          const rendered = await renderPageAsImage(proxy, pageNumber, {
            scale: 2,
            canvasImport: () => import('@napi-rs/canvas'),
          })
          const bytes = new Uint8Array(rendered)
          const target = pageImagePath(document.fingerprint, pageNumber)
          await mkdir(path.dirname(target), { recursive: true })
          await writeFile(target, bytes)
          found.set(pageNumber, bytes)
        } catch {
          // Reported through `missing`; the page's text is still in the call.
        }
      }
    })
  }

  const images: PageImage[] = []
  const missing: number[] = []
  for (const pageNumber of pageNumbers) {
    const bytes = found.get(pageNumber)
    if (bytes) images.push({ page: pageNumber, dataUrl: toDataUrl(bytes) })
    else missing.push(pageNumber)
  }
  return { images, missing }
}

export interface VolumeSplit {
  parts: PlanPart[]
  reason: 'image-limit' | 'context-limit' | null
}

/** Cuts the document into consecutive page ranges only when one call cannot hold it. */
export function splitIntoVolumes(
  pages: readonly ReadablePage[],
  imagePages: readonly number[],
  limits: { maxImages?: number; maxTokens?: number } = {},
): VolumeSplit {
  const maxImages = limits.maxImages ?? MAX_IMAGES_PER_CALL
  const maxTokens = limits.maxTokens ?? MAX_INPUT_TOKENS_PER_CALL
  const needsImage = new Set(imagePages)
  const parts: PlanPart[] = []
  let reason: VolumeSplit['reason'] = null
  let current: PlanPart | null = null
  let tokens = 0

  for (const page of pages) {
    const pageImages = needsImage.has(page.page) ? 1 : 0
    const pageTokens = estimateTokens(page.text) + pageImages * TOKENS_PER_IMAGE
    if (current) {
      const overImages = current.imagePages.length + pageImages > maxImages
      const overTokens = tokens + pageTokens > maxTokens
      if (overImages || overTokens) {
        reason = reason ?? (overImages ? 'image-limit' : 'context-limit')
        parts.push(current)
        current = null
      }
    }
    if (!current) {
      current = { fromPage: page.page, toPage: page.page, imagePages: [] }
      tokens = 0
    }
    current.toPage = page.page
    if (pageImages) current.imagePages.push(page.page)
    tokens += pageTokens
  }
  if (current) parts.push(current)
  return { parts, reason }
}

export function volumeNote(split: VolumeSplit, imageCount: number): string | null {
  if (split.parts.length < 2) return null
  const cause =
    split.reason === 'image-limit'
      ? `This text needs ${imageCount} page images and one call accepts ${MAX_IMAGES_PER_CALL}`
      : 'This text is longer than one call can hold'
  return `${cause}, so it was read in ${split.parts.length} parts. Each part was planned separately and the steps were merged in problem order.`
}
