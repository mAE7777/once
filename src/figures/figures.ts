import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { buildObjectPrompt, decodeMaskToRaster, decodeMaskToSVGPath, type SegmentationMask } from '@meta-sam/parser'
import { OnceError } from '@/errors/errors'
import { metaResponses, responseText } from '@/lib/meta'
import { viewStoredPlan } from '@/deepread/deepread'
import { getArtifact, putArtifact, readArtifact } from '@/store/store'

export class FigureError extends OnceError { constructor(m: string) { super(502, m); this.name = 'FigureError' } }

export const FIGURE_MODEL = 'sam-3.1'
export const FIGURE_VERSION = 'figure-2'
const LOCATE_MODEL = 'muse-spark-1.3'
const FIGURE_KIND = 'figure'
const MIN_CONFIDENCE = 0.5
const MAX_PAGE_SHARE = 0.6

export interface PixelBox { x: number; y: number; w: number; h: number }
interface PageSize { width: number; height: number }
export interface SamObject { box: PixelBox; confidence: number | null; mask: SegmentationMask | null }
/** `box` is in thousandths of the page, the unit the reader's overlay draws in. `mask` is an SVG path over `maskSize`, anchored at the box corner. */
export interface FigureResult { kind: 'mask' | 'box'; page: number; concept: string; box: PixelBox; mask: string | null; maskSize: { w: number; h: number } | null }

export function parseSamText(text: string): SamObject[] {
  const out: SamObject[] = []
  const re = /<\|box;x1=(\d+);y1=(\d+);x2=(\d+);y2=(\d+)(?:;w=\d+;h=\d+)?(?:;c=([\d.]+))?\|>(?:<\|mask;x=\d+;y=\d+;(?:c=[\d.]+;)?data=(\d+),(\d+),([~!][^|]*)\|>)?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const x1 = +m[1], y1 = +m[2], x2 = +m[3], y2 = +m[4]
    // Wire corners are inclusive, and the mask raster is anchored at the box corner (x1, y1).
    out.push({
      box: { x: x1, y: y1, w: x2 - x1 + 1, h: y2 - y1 + 1 },
      confidence: m[5] ? +m[5] : null,
      mask: m[8] ? { encoding: m[8].startsWith('!') ? 'one_bit' : 'lossless', payload: m[8], height: +m[6], width: +m[7] } : null,
    })
  }
  return out
}

function pngSize(png: Buffer): PageSize | null {
  if (png.length < 24 || png.toString('latin1', 12, 16) !== 'IHDR') return null
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

function toThousandths(box: PixelBox, size: PageSize): PixelBox {
  return { x: (box.x / size.width) * 1000, y: (box.y / size.height) * 1000, w: (box.w / size.width) * 1000, h: (box.h / size.height) * 1000 }
}

/** A region is only real position data when it lands on the page; one that runs off the edge is trimmed to it. */
function regionOnPage(region: PixelBox | null, size: PageSize): PixelBox | null {
  if (!region) return null
  const { x, y, w, h } = region
  if (![x, y, w, h].every(Number.isFinite) || x < 0 || y < 0 || w <= 0 || h <= 0 || x >= size.width || y >= size.height) return null
  const left = Math.round(x), top = Math.round(y)
  const right = Math.min(Math.round(x + w), size.width), bottom = Math.min(Math.round(y + h), size.height)
  return right > left && bottom > top ? { x: left, y: top, w: right - left, h: bottom - top } : null
}

export function boxPrompt(region: PixelBox, size: PageSize): string {
  return buildObjectPrompt({ size, objects: [{ id: 1, prompts: [{ box: { left: region.x, top: region.y, right: region.x + region.w, bottom: region.y + region.h } }] }] })
}

function drawableMask(object: SamObject, size: PageSize, region: PixelBox | null): { path: string; w: number; h: number } | null {
  const { box, confidence, mask } = object
  if (!mask || (confidence !== null && confidence < MIN_CONFIDENCE)) return null
  // A mask that swallows the page says nothing about one part of a figure.
  if (box.w * box.h > size.width * size.height * MAX_PAGE_SHARE) return null
  if (region) {
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2
    if (cx < region.x || cx > region.x + region.w || cy < region.y || cy > region.y + region.h) return null
  }
  try {
    if (!decodeMaskToRaster(mask).some((bit) => bit === 1)) return null
    return { path: decodeMaskToSVGPath(mask), w: mask.width, h: mask.height }
  } catch {
    return null
  }
}

async function segment(png: Buffer, prompt: string, fetchImpl: typeof fetch): Promise<SamObject[]> {
  const json = await metaResponses({
    model: FIGURE_MODEL,
    stream: false,
    metadata: { mask_encoding: 'one_bit', include_confidence: 'true' },
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }, { type: 'input_image', image_url: `data:image/png;base64,${png.toString('base64')}` }] }],
  }, fetchImpl)
  return parseSamText(responseText(json))
}

/** Finds where a named part sits on the page, since a box prompt succeeds on figures where a phrase alone does not. */
export async function locateRegion(png: Buffer, concept: string, size: PageSize, fetchImpl: typeof fetch): Promise<PixelBox | null> {
  const json = await metaResponses({
    model: LOCATE_MODEL,
    store: false,
    reasoning: { effort: 'low' },
    text: {
      format: {
        type: 'json_schema',
        name: 'figure_region',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['found', 'left', 'top', 'right', 'bottom'],
          properties: { found: { type: 'boolean' }, left: { type: 'number' }, top: { type: 'number' }, right: { type: 'number' }, bottom: { type: 'number' } },
        },
      },
    },
    input: [{ type: 'message', role: 'user', content: [
      { type: 'input_image', image_url: `data:image/png;base64,${png.toString('base64')}` },
      { type: 'input_text', text: `Find this part of a figure on the page: ${concept}. Give its tight bounding box with each edge from 0 to 1000 across the page width and height. Set found to false if it is not on the page.` },
    ] }],
  }, fetchImpl)
  const answer = JSON.parse(responseText(json)) as { found: boolean; left: number; top: number; right: number; bottom: number }
  if (!answer.found) return null
  return regionOnPage({
    x: (answer.left / 1000) * size.width,
    y: (answer.top / 1000) * size.height,
    w: ((answer.right - answer.left) / 1000) * size.width,
    h: ((answer.bottom - answer.top) / 1000) * size.height,
  }, size)
}

function bestMask(objects: SamObject[], size: PageSize, region: PixelBox | null, page: number, concept: string): FigureResult | null {
  const ranked = [...objects].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
  for (const object of ranked) {
    const drawn = drawableMask(object, size, region)
    if (drawn) return { kind: 'mask', page, concept, box: toThousandths(object.box, size), mask: drawn.path, maskSize: { w: drawn.w, h: drawn.h } }
  }
  return null
}

/**
 * A region, from the plan or located on the page, is sent as a box prompt, which gives a clean mask on figures; without
 * a mask the region itself is drawn. With no region the plan's phrase is the only prompt left, and a miss shows nothing.
 */
export async function figureForPoint(fingerprint: string, pointId: string, fetchImpl: typeof fetch = fetch): Promise<FigureResult | null> {
  const view = await viewStoredPlan(fingerprint)
  if (!view.stored) return null
  const part = view.stored.plan.steps.flatMap((s) => s.points).find((p) => p.id === pointId)?.figurePart
  if (!part) return null
  const { page, concept } = part

  const key = createHash('sha256').update(`${page}\n${concept}\n${JSON.stringify(part.region)}`).digest('hex')
  const cached = getArtifact(fingerprint, FIGURE_KIND, key, { model: FIGURE_MODEL, promptVersion: FIGURE_VERSION })
  if (cached?.isCurrent) return (JSON.parse(readArtifact(cached.path).toString('utf8')) as { result: FigureResult | null }).result

  const png = await readFile(path.join(/*turbopackIgnore: true*/ process.cwd(), 'data', 'pages', fingerprint, `p${page}.png`)).catch(() => null)
  const size = png && pngSize(png)
  if (!png || !size) return null
  const region = regionOnPage(part.region, size) ?? await locateRegion(png, concept, size, fetchImpl).catch(() => null)

  let objects: SamObject[]
  try {
    objects = await segment(png, region ? boxPrompt(region, size) : concept, fetchImpl)
  } catch {
    // A failed call says nothing about the figure, so it is not remembered and the next visit asks again.
    if (region) return { kind: 'box', page, concept, box: toThousandths(region, size), mask: null, maskSize: null }
    throw new FigureError('The figure could not be read just now.')
  }

  const result = bestMask(objects, size, region, page, concept)
    ?? (region ? { kind: 'box' as const, page, concept, box: toThousandths(region, size), mask: null, maskSize: null } : null)
  putArtifact({ fingerprint, kind: FIGURE_KIND, key, model: FIGURE_MODEL, promptVersion: FIGURE_VERSION, data: Buffer.from(JSON.stringify({ result })) })
  return result
}
