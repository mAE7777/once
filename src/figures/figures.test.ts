import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PLAN_ARTIFACT_KIND, PLAN_MODEL, PROMPT_VERSION, planArtifactKey } from '@/deepread/deepread'
import { FINGERPRINT, storeDocument, textPage } from '@/deepread/fixtures'
import { closeDb, putArtifact, resetStoreForTests } from '@/store/store'
import { planOver } from '@/traces/fixtures'
import { boxPrompt, figureForPoint, parseSamText } from './figures'
import { GET as getFigure } from '../../app/api/documents/[fingerprint]/figure/route'

// Captured from sam-3.1 on the architecture figure, with a box prompt on the multi-head attention block.
const REAL_PAYLOAD = "!!!!!XDBG?pGT@e5^w5?5(O'Yf/O%I{d!aTi`iGKY0TuKi[AD*M&8Nd@Uy^UqIr@'49l]"
const realObject = (id: number, c: number) => `${id}<|box;x1=481;y1=525;x2=586;y2=571;w=1224;h=1584;c=${c}|><|mask;x=0;y=0;c=${c};data=47,106,${REAL_PAYLOAD}|>`
const REAL_WIRE = `<0f>${realObject(1, 0.94140625)}\n`
const REGION = { x: 425, y: 385, w: 180, h: 220 }

function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header)
  header.writeUInt32BE(13, 8); header.write('IHDR', 12, 'latin1'); header.writeUInt32BE(width, 16); header.writeUInt32BE(height, 20)
  return header
}
const sam = (text: string, status = 200) => new Response(status === 200 ? JSON.stringify({ output_text: text }) : JSON.stringify({ error: { message: 'down' } }), { status, headers: { 'Content-Type': 'application/json' } })

let workDir: string
let previousCwd: string
let sentences: Awaited<ReturnType<typeof storeDocument>>

async function plan(figurePart: unknown, page = true) {
  const stored = planOver(FINGERPRINT, sentences)
  stored.steps[0].points[0].figurePart = figurePart as never
  putArtifact({ fingerprint: FINGERPRINT, kind: PLAN_ARTIFACT_KIND, key: planArtifactKey(), model: PLAN_MODEL, promptVersion: PROMPT_VERSION, data: Buffer.from(JSON.stringify(stored)) })
  const dir = path.join(process.cwd(), 'data', 'pages', FINGERPRINT)
  await mkdir(dir, { recursive: true })
  if (page) await writeFile(path.join(dir, 'p1.png'), png(1224, 1584))
  return stored.steps[0].points[0].id
}
function located(answer: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ output_text: JSON.stringify(answer) }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function fakeSam(...replies: (() => Response)[]) {
  return fakeSamWithLocator({ found: false, left: 0, top: 0, right: 0, bottom: 0 }, ...replies)
}

function fakeSamWithLocator(answer: Record<string, unknown>, ...replies: (() => Response)[]) {
  const prompts: string[] = []
  const metadata: unknown[] = []
  let calls = 0
  const fn = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    prompts.push(body.input[0].content[0].text); metadata.push(body.metadata)
    const next = replies[calls++]
    if (!next) throw new Error(`unexpected model call ${calls}`)
    return next()
  })
  const locateCalls = vi.fn()
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    if (JSON.parse(String(init?.body)).model !== 'sam-3.1') { locateCalls(); return located(answer) }
    return fn(url, init)
  }) as unknown as typeof fetch
  return { fetchImpl, fn, prompts, metadata, locateCalls }
}

beforeEach(async () => {
  previousCwd = process.cwd()
  workDir = await mkdtemp(path.join(tmpdir(), 'once-figures-'))
  process.chdir(workDir)
  resetStoreForTests()
  process.env.META_API_KEY = 'test-key'
  sentences = await storeDocument([textPage(1, 'People translated by hand. It took years to learn.'), textPage(2, 'Attention looks back at the input. It weighs each part.')])
})
afterEach(async () => {
  closeDb()
  vi.unstubAllGlobals()
  process.chdir(previousCwd)
  await rm(workDir, { recursive: true, force: true })
})

describe('parseSamText', () => {
  it('reads the real wire format with confidence and a mask anchored at the box corner', () => {
    expect(parseSamText(REAL_WIRE)).toEqual([{ box: { x: 481, y: 525, w: 106, h: 47 }, confidence: 0.94140625, mask: { encoding: 'one_bit', payload: REAL_PAYLOAD, height: 47, width: 106 } }])
  })
  it('reads every object of a concept reply', () => { expect(parseSamText(`<0f>${realObject(0, 0.75)},${realObject(1, 0.76)}\n`)).toHaveLength(2) })
  it('reads a box with no confidence or mask', () => { expect(parseSamText('<|box;x1=10;y1=20;x2=29;y2=39;w=20;h=20|>')).toEqual([{ box: { x: 10, y: 20, w: 20, h: 20 }, confidence: null, mask: null }]) })
  it('returns nothing for no match', () => { expect(parseSamText('')).toEqual([]) })
})

describe('boxPrompt', () => {
  it('writes the inclusive corners the API accepted live', () => {
    expect(boxPrompt(REGION, { width: 1224, height: 1584 })).toBe('<0f>1<|box;x1=425;y1=385;x2=604;y2=604;w=1224;h=1584|>')
  })
})

describe('figureForPoint', () => {
  it('turns a plan region into a box prompt and returns the mask in page thousandths', async () => {
    const id = await plan({ page: 1, region: REGION, concept: 'the encoder layer' })
    const sam1 = fakeSam(() => sam(`<0f>1<|box;x1=440;y1=400;x2=545;y2=446;w=1224;h=1584;c=0.9|><|mask;x=0;y=0;c=0.9;data=47,106,${REAL_PAYLOAD}|>\n`))
    const result = await figureForPoint(FINGERPRINT, id, sam1.fetchImpl)
    expect(sam1.prompts).toEqual(['<0f>1<|box;x1=425;y1=385;x2=604;y2=604;w=1224;h=1584|>'])
    expect(sam1.metadata).toEqual([{ mask_encoding: 'one_bit', include_confidence: 'true' }])
    expect(result).toMatchObject({ kind: 'mask', page: 1, concept: 'the encoder layer', maskSize: { w: 106, h: 47 } })
    expect(result?.box.x).toBeCloseTo((440 / 1224) * 1000); expect(result?.box.y).toBeCloseTo((400 / 1584) * 1000)
    expect(result?.box.w).toBeCloseTo((106 / 1224) * 1000); expect(result?.box.h).toBeCloseTo((47 / 1584) * 1000)
    expect(result?.mask).toMatch(/^M.*Z/)
  })
  it('answers from the cache on the second visit with no paid call', async () => {
    const id = await plan({ page: 1, region: REGION, concept: 'the encoder layer' })
    const sam1 = fakeSam(() => sam(`<0f>1<|box;x1=440;y1=400;x2=545;y2=446;w=1224;h=1584;c=0.9|><|mask;x=0;y=0;c=0.9;data=47,106,${REAL_PAYLOAD}|>\n`))
    const first = await figureForPoint(FINGERPRINT, id, sam1.fetchImpl)
    const second = await figureForPoint(FINGERPRINT, id, sam1.fetchImpl)
    expect(second).toEqual(first); expect(sam1.fn).toHaveBeenCalledTimes(1)
  })
  it('falls back to the plan region as a box when the prompt finds nothing, and remembers it', async () => {
    const id = await plan({ page: 1, region: REGION, concept: 'the encoder layer' })
    const sam1 = fakeSam(() => sam(''))
    const result = await figureForPoint(FINGERPRINT, id, sam1.fetchImpl)
    expect(result).toMatchObject({ kind: 'box', page: 1, mask: null, maskSize: null })
    expect(result?.box.x).toBeCloseTo((425 / 1224) * 1000); expect(result?.box.h).toBeCloseTo((220 / 1584) * 1000)
    await figureForPoint(FINGERPRINT, id, sam1.fetchImpl); expect(sam1.fn).toHaveBeenCalledTimes(1)
  })
  it('does not trust a mask that lands away from the region', async () => {
    const id = await plan({ page: 1, region: REGION, concept: 'the encoder layer' })
    const sam1 = fakeSam(() => sam(`<0f>1<|box;x1=900;y1=1200;x2=1005;y2=1246;w=1224;h=1584;c=0.9|><|mask;x=0;y=0;c=0.9;data=47,106,${REAL_PAYLOAD}|>\n`))
    expect(await figureForPoint(FINGERPRINT, id, sam1.fetchImpl)).toMatchObject({ kind: 'box' })
  })
  it('draws the region when the call fails, and asks again next time', async () => {
    const id = await plan({ page: 1, region: REGION, concept: 'the encoder layer' })
    const sam1 = fakeSam(() => sam('', 500), () => sam(''))
    expect(await figureForPoint(FINGERPRINT, id, sam1.fetchImpl)).toMatchObject({ kind: 'box' })
    await figureForPoint(FINGERPRINT, id, sam1.fetchImpl); expect(sam1.fn).toHaveBeenCalledTimes(2)
  })
  it('uses the phrase when there is no region and takes the most confident usable mask', async () => {
    const id = await plan({ page: 1, region: null, concept: 'orange box' })
    const sam1 = fakeSam(() => sam(`<0f>${realObject(0, 0.75)},1<|box;x1=100;y1=200;x2=205;y2=246;w=1224;h=1584;c=0.9|><|mask;x=0;y=0;c=0.9;data=47,106,${REAL_PAYLOAD}|>\n`))
    const result = await figureForPoint(FINGERPRINT, id, sam1.fetchImpl)
    expect(sam1.prompts).toEqual(['orange box']); expect(result).toMatchObject({ kind: 'mask' }); expect(result?.box.x).toBeCloseTo((100 / 1224) * 1000)
  })
  it('skips low confidence and page-swallowing masks', async () => {
    const id = await plan({ page: 1, region: null, concept: 'orange box' })
    const sam1 = fakeSam(() => sam(`<0f>${realObject(0, 0.2)},1<|box;x1=0;y1=0;x2=1223;y2=1583;w=1224;h=1584;c=0.9|><|mask;x=0;y=0;c=0.9;data=47,106,${REAL_PAYLOAD}|>\n`))
    expect(await figureForPoint(FINGERPRINT, id, sam1.fetchImpl)).toBeNull()
  })
  it('shows nothing with no region and no match, and does not pay twice', async () => {
    const id = await plan({ page: 1, region: null, concept: 'the encoder layer' })
    const sam1 = fakeSam(() => sam(''))
    expect(await figureForPoint(FINGERPRINT, id, sam1.fetchImpl)).toBeNull()
    expect(await figureForPoint(FINGERPRINT, id, sam1.fetchImpl)).toBeNull(); expect(sam1.fn).toHaveBeenCalledTimes(1)
  })
  it('locates a part the plan gave no region for and sends it as a box prompt', async () => {
    const id = await plan({ page: 1, region: null, concept: 'the encoder block' })
    const sam1 = fakeSamWithLocator({ found: true, left: 50, top: 100, right: 500, bottom: 400 }, () => sam(''))
    const result = await figureForPoint(FINGERPRINT, id, sam1.fetchImpl)
    expect(sam1.locateCalls).toHaveBeenCalledTimes(1)
    expect(sam1.prompts[0]).not.toBe('the encoder block')
    expect(result).toMatchObject({ kind: 'box' })
    expect(result?.box.x).toBeCloseTo(50, 0)
    expect(result?.box.w).toBeCloseTo(450, 0)
  })
  it('reports a failed call when there is no region to draw', async () => {
    const id = await plan({ page: 1, region: null, concept: 'the encoder layer' })
    await expect(figureForPoint(FINGERPRINT, id, fakeSam(() => sam('', 500)).fetchImpl)).rejects.toMatchObject({ status: 502 })
  })
  it('ignores a region that is off the page', async () => {
    const off = await plan({ page: 1, region: { x: 2000, y: 10, w: 50, h: 50 }, concept: 'orange box' })
    const sam1 = fakeSam(() => sam(''))
    expect(await figureForPoint(FINGERPRINT, off, sam1.fetchImpl)).toBeNull(); expect(sam1.prompts).toEqual(['orange box'])
  })
  it('trims a region that runs over the edge', async () => {
    const over = await plan({ page: 1, region: { x: 1200, y: 1500, w: 100, h: 200 }, concept: 'another part' })
    const sam2 = fakeSam(() => sam(''))
    const result = await figureForPoint(FINGERPRINT, over, sam2.fetchImpl)
    expect(sam2.prompts).toEqual(['<0f>1<|box;x1=1200;y1=1500;x2=1223;y2=1583;w=1224;h=1584|>'])
    expect(result?.box.w).toBeCloseTo((24 / 1224) * 1000); expect(result?.box.h).toBeCloseTo((84 / 1584) * 1000)
  })
  it('makes no call without a figure part or a page image', async () => {
    const none = await plan(null)
    const f = fakeSam()
    expect(await figureForPoint(FINGERPRINT, none, f.fetchImpl)).toBeNull()
    expect(await figureForPoint(FINGERPRINT, 'missing', f.fetchImpl)).toBeNull()
    expect(f.fn).not.toHaveBeenCalled()
  })
  it('makes no call when the page image is missing', async () => {
    const f = fakeSam()
    const stored = planOver(FINGERPRINT, sentences)
    stored.steps[0].points[0].figurePart = { page: 2, region: REGION, concept: 'x' } as never
    putArtifact({ fingerprint: FINGERPRINT, kind: PLAN_ARTIFACT_KIND, key: planArtifactKey(), model: PLAN_MODEL, promptVersion: PROMPT_VERSION, data: Buffer.from(JSON.stringify(stored)) })
    expect(await figureForPoint(FINGERPRINT, stored.steps[0].points[0].id, f.fetchImpl)).toBeNull(); expect(f.fn).not.toHaveBeenCalled()
  })
})

describe('figure route', () => {
  const params = () => ({ params: Promise.resolve({ fingerprint: FINGERPRINT }) })
  it('gives the overlay a box shape it can draw', async () => {
    const id = await plan({ page: 1, region: REGION, concept: 'the encoder layer' })
    vi.stubGlobal('fetch', fakeSam(() => sam('')).fetchImpl)
    const body = await (await getFigure(new Request(`http://once.test/x?point=${id}`), params())).json()
    expect(body).toMatchObject({ found: true, kind: 'box', page: 1, mask: null }); expect(body.box.x).toBeGreaterThan(0); expect(body.box.x).toBeLessThan(1000)
  })
  it('says found false when there is nothing to show', async () => {
    const id = await plan({ page: 1, region: null, concept: 'the encoder layer' })
    vi.stubGlobal('fetch', fakeSam(() => sam('')).fetchImpl)
    expect(await (await getFigure(new Request(`http://once.test/x?point=${id}`), params())).json()).toEqual({ found: false })
  })
})
