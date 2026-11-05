import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { getDocumentProxy, getResolvedPDFJS, renderPageAsImage } from 'unpdf'
import type { ReadablePage, ReadableTextItem } from '@/lib/types'
import { attachCharEnds, readPlacedGlyphs } from './advances'
import { buildPageText } from './ordering'
import { blocksToItems, readPageBlocks } from './ocr'

export class PdfReadableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PdfReadableError'
  }
}

export interface PdfReadableOptions {
  metaFetchImpl?: typeof fetch
}

const IMAGE_OP_NAMES = [
  'paintImageXObject',
  'paintInlineImageXObject',
  'paintImageMaskXObject',
  'paintInlineImageXObjectGroup',
  'paintImageXObjectRepeat',
  'paintImageMaskXObjectGroup',
  'paintImageMaskXObjectRepeat',
] as const

async function operatorCodes(): Promise<Record<string, number> | null> {
  try {
    const pdfjs = await getResolvedPDFJS()
    return (pdfjs as { OPS?: Record<string, number> }).OPS ?? null
  } catch {
    return null
  }
}

function imageOpCodes(ops: Record<string, number> | null): Set<number> {
  const codes = new Set<number>()
  if (!ops) return codes
  for (const name of IMAGE_OP_NAMES) {
    const code = ops[name]
    if (typeof code === 'number') codes.add(code)
  }
  return codes
}

interface RawTextItem {
  str?: unknown
  transform?: unknown
  width?: unknown
  height?: unknown
}

function toReadableItem(raw: RawTextItem): ReadableTextItem | null {
  if (typeof raw.str !== 'string') return null
  const transform = Array.isArray(raw.transform) ? raw.transform : []
  const x = typeof transform[4] === 'number' ? transform[4] : 0
  const y = typeof transform[5] === 'number' ? transform[5] : 0
  const w = typeof raw.width === 'number' ? raw.width : 0
  const h = typeof raw.height === 'number' ? raw.height : 0
  return { str: raw.str, x, y, w, h }
}

export async function extractPdfPages(
  bytes: Uint8Array,
  fingerprint: string,
  options: PdfReadableOptions = {},
): Promise<ReadablePage[]> {
  const proxy = await getDocumentProxy(new Uint8Array(bytes))
  const ops = await operatorCodes()
  const opCodes = imageOpCodes(ops)
  const pages: ReadablePage[] = []

  try {
    for (let pageNumber = 1; pageNumber <= proxy.numPages; pageNumber += 1) {
      const page = await proxy.getPage(pageNumber)
      try {
        const viewport = page.getViewport({ scale: 1 })
        const width = viewport.width
        const height = viewport.height

        const textContent = await page.getTextContent()
        const items: ReadableTextItem[] = []
        for (const raw of textContent.items as RawTextItem[]) {
          const item = toReadableItem(raw)
          if (item) items.push(item)
        }
        const extractedText = buildPageText(items, width)
        const hasText = extractedText.trim().length > 0

        // A page counts as a scan when its operator list paints an image and it has almost no extractable text.
        let paintsImage = false
        let operatorListAvailable = false
        try {
          const operatorList = await page.getOperatorList()
          operatorListAvailable = true
          if (opCodes.size > 0) {
            paintsImage = operatorList.fnArray.some((code: number) => opCodes.has(code))
          }
          if (ops) {
            const fontScale = (fontName: string): number => {
              try {
                const scale = (page.commonObjs.get(fontName) as { fontMatrix?: number[] }).fontMatrix?.[0]
                return typeof scale === 'number' ? scale : 0.001
              } catch {
                return 0.001
              }
            }
            attachCharEnds(items, readPlacedGlyphs({ ...operatorList, ops, fontScale }))
          }
        } catch {
          operatorListAvailable = false
        }

        const isScan = operatorListAvailable && opCodes.size > 0
          ? !hasText && paintsImage
          : !hasText
        const shouldRender = isScan || paintsImage

        let image: string | undefined
        let imageBytes: Uint8Array | null = null
        if (shouldRender) {
          try {
            const rendered = await renderPageAsImage(proxy, pageNumber, {
              scale: 2,
              canvasImport: () => import('@napi-rs/canvas'),
            })
            imageBytes = new Uint8Array(rendered)
            const relative = path.posix.join('data', 'pages', fingerprint, `p${pageNumber}.png`)
            const absolute = path.join(
              process.cwd(),
              'data',
              'pages',
              fingerprint,
              `p${pageNumber}.png`,
            )
            await mkdir(path.dirname(absolute), { recursive: true })
            await writeFile(absolute, imageBytes)
            image = relative
          } catch {
            if (isScan) {
              throw new PdfReadableError(
                `Page ${pageNumber} is a scanned page, but its image could not be created, so this page cannot be read.`,
              )
            }
            image = undefined
            imageBytes = null
          }
        }

        let text = extractedText
        let pageItems = items
        if (isScan) {
          if (!imageBytes) {
            throw new PdfReadableError(
              `Page ${pageNumber} is a scanned page, but its image could not be created, so this page cannot be read.`,
            )
          }
          const blocks = await readPageBlocks(imageBytes, options.metaFetchImpl ?? fetch)
          text = blocks.map(b=>b.text).join('\n')
          pageItems = blocksToItems(blocks, width, height)
          pages.push({ page: pageNumber, width, height, text, items: pageItems, isScan, ...(image?{image}:{}) , blocks} as never)
          continue
        }

        const readablePage: ReadablePage = {
          page: pageNumber,
          width,
          height,
          text,
          items: pageItems,
          isScan,
        }
        if (image) readablePage.image = image
        pages.push(readablePage)
      } finally {
        page.cleanup()
      }
    }
  } finally {
    const closable = proxy as unknown as { destroy?: () => Promise<void> }
    await closable.destroy?.()
  }

  return pages
}
