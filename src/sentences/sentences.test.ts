import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ReadableDocument, ReadableTextItem } from '@/lib/types'
import { buildSentenceDocument, segmentPageText, sentencesForDrawing, spanWithinItem } from './sentences'
import { POST } from '../../app/api/documents/[fingerprint]/sentences/route'

function textsOf(text: string): string[] {
  return segmentPageText(text).map((span) => span.text)
}

function docWith(
  text: string,
  items: ReadableTextItem[] = [],
  fingerprint = 'a'.repeat(64),
): ReadableDocument {
  return {
    fingerprint,
    kind: 'pdf',
    pageCount: 1,
    fullText: text,
    pages: [{ page: 1, width: 612, height: 792, text, items, isScan: false }],
  }
}

describe('segmentPageText', () => {
  it('does not split after abbreviations, inside decimals, or away from citations', () => {
    const text =
      'Fig. 3 shows a gain of 3.5 points, e.g. on the first task. ' +
      'The result beats the baseline vs. the old model reported by Dr. Lee et al. in 2019. ' +
      'It also holds [12]. ' +
      'The method follows (Vaswani et al., 2017) closely. ' +
      'Eq. 4 gives the score, i.e. the final value.'

    expect(textsOf(text)).toEqual([
      'Fig. 3 shows a gain of 3.5 points, e.g. on the first task.',
      'The result beats the baseline vs. the old model reported by Dr. Lee et al. in 2019.',
      'It also holds [12].',
      'The method follows (Vaswani et al., 2017) closely.',
      'Eq. 4 gives the score, i.e. the final value.',
    ])
  })

  it('does not split a decimal broken across a line', () => {
    const text = 'The value is 3.\n5 points today. It rose again.'

    expect(textsOf(text)).toEqual(['The value is 3.\n5 points today.', 'It rose again.'])
  })

  it('keeps single-capital initials with the name that follows', () => {
    const text = 'A. Vaswani and J. R. Smith wrote the paper. It appeared in 2017. Mr. Wu read it.'

    expect(textsOf(text)).toEqual([
      'A. Vaswani and J. R. Smith wrote the paper.',
      'It appeared in 2017.',
      'Mr. Wu read it.',
    ])
  })

  it('splits on Chinese terminators', () => {
    const text = '\u7b2c\u4e00\u53e5\u8bdd\u5728\u8fd9\u91cc\u3002\u7b2c\u4e8c\u53e5\u5728\u95ee\u95ee\u9898\u5417\uff1f\u7b2c\u4e09\u53e5\u5f88\u60ca\u8bb6\uff01\u6700\u540e\u4e00\u53e5\u6ca1\u6709\u6807\u70b9'

    expect(textsOf(text)).toEqual([
      '\u7b2c\u4e00\u53e5\u8bdd\u5728\u8fd9\u91cc\u3002',
      '\u7b2c\u4e8c\u53e5\u5728\u95ee\u95ee\u9898\u5417\uff1f',
      '\u7b2c\u4e09\u53e5\u5f88\u60ca\u8bb6\uff01',
      '\u6700\u540e\u4e00\u53e5\u6ca1\u6709\u6807\u70b9',
    ])
  })

  it('joins lines that wrap one sentence', () => {
    const text =
      'The dominant models are based on complex recurrent or\n' +
      'convolutional networks that include an encoder and a decoder. The best\n' +
      'performing models also connect them through attention.'

    expect(textsOf(text)).toEqual([
      'The dominant models are based on complex recurrent or\nconvolutional networks that include an encoder and a decoder.',
      'The best\nperforming models also connect them through attention.',
    ])
  })

  it('keeps a closing quote or bracket with its sentence', () => {
    const text = 'He said "stop right there." Then the note [see Fig. 2] was added. It ended.'

    expect(textsOf(text)).toEqual([
      'He said "stop right there."',
      'Then the note [see Fig. 2] was added.',
      'It ended.',
    ])
  })
})

function expectInvariants(text: string) {
  const document = buildSentenceDocument(docWith(text))
  const sentences = document.sentences

  sentences.forEach((sentence, index) => {
    expect(sentence.id).toBe(`s${index + 1}`)
    expect(sentence.page).toBe(1)
    expect(sentence.text).toBe(text.slice(sentence.start, sentence.end))
    expect(sentence.text.length).toBeGreaterThan(0)
    expect(sentence.text).toBe(sentence.text.trim())
    expect(sentence.boxes).toEqual([])
    if (index > 0) {
      expect(sentence.start).toBeGreaterThanOrEqual(sentences[index - 1].end)
      expect(sentence.start).toBeGreaterThan(sentences[index - 1].start)
    }
  })

  const coverage = new Array<number>(text.length).fill(0)
  for (const sentence of sentences) {
    for (let i = sentence.start; i < sentence.end; i += 1) coverage[i] += 1
  }
  for (let i = 0; i < text.length; i += 1) {
    if (/\s/.test(text[i])) {
      expect(coverage[i]).toBeLessThanOrEqual(1)
    } else {
      expect(coverage[i]).toBe(1)
    }
  }

  let rebuilt = ''
  let position = 0
  for (const sentence of sentences) {
    const gap = text.slice(position, sentence.start)
    expect(gap).toMatch(/^\s*$/)
    rebuilt += gap + sentence.text
    position = sentence.end
  }
  const tail = text.slice(position)
  expect(tail).toMatch(/^\s*$/)
  rebuilt += tail
  expect(rebuilt).toBe(text)

  return sentences
}

describe('sentence invariants', () => {
  it('holds over a tricky mixed paragraph with emoji and no offset drift', () => {
    const text =
      '  Dr. A. Vaswani et al. 🚀 reported 3.5 points in Fig. 3 [12].\n\n' +
      'He said "the value 👨‍👩‍👧 holds." \u4e2d\u6587\u53e5\u5b50\u5728\u8fd9\u91cc\uff01\u4e0b\u4e00\u53e5\u662f\u4e2d\u6587\u5417\uff1f\n' +
      'The note (Vaswani et al., 2017) vs. the baseline, i.e. the old one, still stands.  ' +
      'Emoji 😀😀 come before Mr. Wu agreed entirely.\nTrailing line without a mark  '

    const sentences = expectInvariants(text)

    const emojiSentence = sentences.find((sentence) => sentence.text.startsWith('Emoji'))
    expect(emojiSentence).toBeDefined()
    expect(emojiSentence?.start).toBe(text.indexOf('Emoji'))
    const chinese = sentences.find((sentence) => sentence.text.startsWith('\u4e2d\u6587'))
    expect(chinese?.start).toBe(text.indexOf('\u4e2d\u6587'))
  })

  it('holds over assorted hard paragraphs', () => {
    const samples = [
      '',
      '   \n\n  ',
      'One sentence only',
      'First. Second? Third! Fourth\u3002\u518d\u89c1\u3002',
      'Value 3.\n5 and 2.75 hold. See Eq. 1, Fig. 2, and Sec. 3. Done [4].',
      'Wrapped lines go on and\non without a mark until\nthey stop. Then a new one starts.',
      'Quotes "inside. Still inside" count once. Brackets [like this.] too. End.',
      'Emoji at the end of a sentence 🎉. The next starts clean. 😀 Leading emoji here.',
    ]
    for (const sample of samples) {
      expectInvariants(sample)
    }
  })
})

describe('sentence boxes', () => {
  it('merges one line of items into one box and skips items missing from the text', () => {
    const text = 'Hello brave new world. Next sentence here.'
    const items: ReadableTextItem[] = [
      { str: 'Hello brave', x: 10, y: 700, w: 50, h: 10 },
      { str: 'ghost words', x: 300, y: 700, w: 50, h: 10 },
      { str: 'new world.', x: 64, y: 700, w: 50, h: 10 },
      { str: 'Next sentence here.', x: 10, y: 680, w: 90, h: 10 },
    ]

    const document = buildSentenceDocument(docWith(text, items))

    expect(document.sentences).toHaveLength(2)
    expect(document.sentences[0].boxes).toEqual([{ x: 10, y: 700, w: 104, h: 10 }])
    expect(document.sentences[1].boxes).toEqual([{ x: 10, y: 680, w: 90, h: 10 }])
  })

  it('produces two boxes for a sentence wrapping two lines', () => {
    const text = 'The quick brown fox jumps over\nthe lazy dog today.'
    const items: ReadableTextItem[] = [
      { str: 'The quick brown fox', x: 10, y: 700, w: 90, h: 10 },
      { str: 'jumps over', x: 104, y: 700, w: 50, h: 10 },
      { str: 'the lazy dog', x: 10, y: 680, w: 60, h: 10 },
      { str: 'today.', x: 74, y: 680, w: 30, h: 10 },
    ]

    const document = buildSentenceDocument(docWith(text, items))

    expect(document.sentences).toHaveLength(1)
    expect(document.sentences[0].text).toBe(text)
    expect(document.sentences[0].boxes).toEqual([
      { x: 10, y: 700, w: 144, h: 10 },
      { x: 10, y: 680, w: 94, h: 10 },
    ])
  })

  it('clips a box where a sentence starts or ends mid-line, without overlapping its neighbour', () => {
    const text = 'One is the total complexity per layer. Another is the amount.'
    const items: ReadableTextItem[] = [{ str: text, x: 0, y: 700, w: text.length * 10, h: 10 }]

    const document = buildSentenceDocument(docWith(text, items))

    expect(document.sentences.map((s) => s.text)).toEqual([
      'One is the total complexity per layer.',
      'Another is the amount.',
    ])
    const [first, second] = document.sentences
    expect(first.boxes).toHaveLength(1)
    expect(second.boxes).toHaveLength(1)
    const firstRight = first.boxes[0].x + first.boxes[0].w
    const expectedFirst = spanWithinItem(text, 0, text.length * 10, 0, first.end)
    const expectedSecond = spanWithinItem(text, 0, text.length * 10, second.start, second.end)
    expect(first.boxes[0].x).toBeCloseTo(expectedFirst.x)
    expect(firstRight).toBeCloseTo(expectedFirst.x + expectedFirst.w)
    expect(firstRight).not.toBeCloseTo(first.text.length * 10, 0)
    expect(second.boxes[0].x).toBeCloseTo(expectedSecond.x)
    expect(second.boxes[0].x + second.boxes[0].w).toBeCloseTo(text.length * 10)
    expect(firstRight).toBeLessThanOrEqual(second.boxes[0].x)
  })

  it('places a narrow-letter word and a wide-letter word by glyph width, not character count', () => {
    // 'ill' is 834 thousandths of an em in Times-Roman, 'mmm' is 2334, the space 250.
    const item = 'ill mmm'
    const total = 834 + 250 + 2334
    const narrow = spanWithinItem(item, 100, 90, 0, 3)
    const wide = spanWithinItem(item, 100, 90, 4, 7)
    expect(narrow.x).toBeCloseTo(100)
    expect(narrow.w).toBeCloseTo((90 * 834) / total)
    expect(wide.x).toBeCloseTo(100 + (90 * (834 + 250)) / total)
    expect(wide.w).toBeCloseTo((90 * 2334) / total)
    // Character counting would put 'mmm' much further right and make 'ill' far too wide.
    expect(narrow.w).toBeLessThan((90 * 3) / item.length - 5)
    expect(wide.x).toBeLessThan(100 + (90 * 4) / item.length - 5)
    expect(narrow.x + narrow.w).toBeLessThanOrEqual(wide.x)
  })

  it('uses measured character edges when an item has them', () => {
    const span = spanWithinItem('ill mmm', 100, 90, 4, 7, [5, 10, 15, 20, 40, 60, 90])
    expect(span).toEqual({ x: 120, w: 70 })
    expect(spanWithinItem('ill mmm', 100, 90, 0, 3, [5, 10, 15, 20, 40, 60, 90])).toEqual({ x: 100, w: 15 })
    expect(spanWithinItem('ill mmm', 100, 90, 3, 3, [5, 10, 15, 20, 40, 60, 90]).w).toBe(0)
  })

  it('falls back to the width table when measurements are absent or do not fit the string', () => {
    const fromTable = spanWithinItem('ill mmm', 100, 90, 4, 7)
    expect(spanWithinItem('ill mmm', 100, 90, 4, 7, undefined)).toEqual(fromTable)
    expect(spanWithinItem('ill mmm', 100, 90, 4, 7, [1, 2, 3])).toEqual(fromTable)
  })

  it('places sentence boxes from measured edges and records their characters', () => {
    const text = 'Ab cd. Ef gh.'
    // Every character 10 wide, except 'd' and the full stop after it, which the table would not guess.
    const charEnds = [10, 20, 30, 40, 90, 100, 110, 120, 130, 140, 150, 160, 170]
    const items: ReadableTextItem[] = [{ str: text, x: 5, y: 700, w: 170, h: 10, charEnds }]
    const { sentences } = buildSentenceDocument(docWith(text, items))
    expect(sentences.map((s) => s.text)).toEqual(['Ab cd.', 'Ef gh.'])
    expect(sentences[0].boxes[0]).toMatchObject({ x: 5, w: 100, start: 0, charEnds: [10, 20, 30, 40, 90, 100] })
    expect(sentences[1].boxes[0]).toMatchObject({ x: 115, w: 60, start: 0, charEnds: [10, 20, 30, 40, 50, 60] })
  })

  it('joins measured items on a line, running the joining space up to the next item', () => {
    const items: ReadableTextItem[] = [
      { str: 'ab', x: 10, y: 700, w: 20, h: 10, charEnds: [8, 20] },
      { str: 'cd', x: 36, y: 700, w: 20, h: 10, charEnds: [12, 20] },
    ]
    const { sentences } = buildSentenceDocument(docWith('ab cd', items))
    expect(sentences[0].boxes).toHaveLength(1)
    expect(sentences[0].boxes[0]).toMatchObject({ x: 10, w: 46, start: 0, charEnds: [8, 20, 26, 38, 46] })
  })

  it('fills an unmeasured item from the width table on a measured page', () => {
    const items: ReadableTextItem[] = [
      { str: 'ab', x: 10, y: 700, w: 20, h: 10, charEnds: [8, 20] },
      { str: 'cd', x: 36, y: 700, w: 20, h: 10 },
    ]
    const { sentences } = buildSentenceDocument(docWith('ab cd', items))
    const edges = sentences[0].boxes[0].charEnds as number[]
    expect(edges).toHaveLength(5)
    expect(edges[2]).toBe(26)
    expect(edges[4]).toBe(46)
  })

  it('adds no character detail to boxes on a page with no measurements', () => {
    const items: ReadableTextItem[] = [{ str: 'ab cd', x: 10, y: 700, w: 50, h: 10 }]
    const { sentences } = buildSentenceDocument(docWith('ab cd', items))
    expect(Object.keys(sentences[0].boxes[0]).sort()).toEqual(['h', 'w', 'x', 'y'])
  })

  it('drops character detail from sentences sent to the page', () => {
    const items: ReadableTextItem[] = [{ str: 'ab', x: 10, y: 700, w: 20, h: 10, charEnds: [8, 20] }]
    const { sentences } = buildSentenceDocument(docWith('ab', items))
    expect(sentencesForDrawing(sentences)[0].boxes).toEqual([{ x: 10, y: 700, w: 20, h: 10 }])
    expect(sentences[0].boxes[0].charEnds).toEqual([8, 20])
  })

  it('clips mid-line sentence ends at glyph positions for narrow and wide words', () => {
    const text = 'ill is narrow. Mmm is wide.'
    const items: ReadableTextItem[] = [{ str: text, x: 0, y: 700, w: 270, h: 10 }]
    const document = buildSentenceDocument(docWith(text, items))
    expect(document.sentences.map((s) => s.text)).toEqual(['ill is narrow.', 'Mmm is wide.'])
    const [first, second] = document.sentences
    const firstGlyph = spanWithinItem(text, 0, 270, 0, first.end)
    const secondGlyph = spanWithinItem(text, 0, 270, second.start, second.end)
    expect(first.boxes[0].x).toBeCloseTo(firstGlyph.x)
    expect(first.boxes[0].w).toBeCloseTo(firstGlyph.w)
    expect(second.boxes[0].x).toBeCloseTo(secondGlyph.x)
    expect(second.boxes[0].x + second.boxes[0].w).toBeCloseTo(270)
  })

  it('keeps ids and spans unchanged while clipping boxes on a shared line', () => {
    const text = 'One is the total complexity per layer. Another is the amount.'
    const bare = buildSentenceDocument(docWith(text))
    const withItems = buildSentenceDocument(
      docWith(text, [{ str: text, x: 0, y: 700, w: text.length * 10, h: 10 }]),
    )

    expect(withItems.sentences.map((s) => s.id)).toEqual(bare.sentences.map((s) => s.id))
    expect(withItems.sentences.map((s) => [s.start, s.end, s.text])).toEqual(
      bare.sentences.map((s) => [s.start, s.end, s.text]),
    )
  })

  it('leaves boxes empty when the page has no items', () => {
    const document = buildSentenceDocument(docWith('Plain text page. No geometry here.'))

    expect(document.sentences.map((sentence) => sentence.boxes)).toEqual([[], []])
  })
})

let workDir: string
let previousCwd: string

beforeEach(async () => {
  previousCwd = process.cwd()
  workDir = await mkdtemp(path.join(tmpdir(), 'once-sentences-'))
  process.chdir(workDir)
})

afterEach(async () => {
  process.chdir(previousCwd)
  await rm(workDir, { recursive: true, force: true })
})

function postSentences(fingerprint: string): Promise<Response> {
  return POST(new Request('http://localhost/sentences', { method: 'POST' }), {
    params: Promise.resolve({ fingerprint }),
  })
}

describe('sentences route file flow', () => {
  it('builds the sentences file once, then returns the cache without rewriting', async () => {
    const fingerprint = 'a'.repeat(64)
    const text = 'Fig. 1 shows it clearly. \u7b2c\u4e8c\u53e5\u5728\u8fd9\u91cc\u3002'
    const readable = docWith(text, [], fingerprint)
    await mkdir(path.join(workDir, 'data', 'readable'), { recursive: true })
    await writeFile(
      path.join(workDir, 'data', 'readable', `${fingerprint}.json`),
      JSON.stringify(readable),
      'utf8',
    )

    const first = await postSentences(fingerprint)
    expect(first.status).toBe(200)
    await expect(first.json()).resolves.toEqual({ fingerprint, sentenceCount: 2 })

    const target = path.join(workDir, 'data', 'sentences', `${fingerprint}.json`)
    const saved = await readFile(target, 'utf8')
    const parsed = JSON.parse(saved) as {
      fingerprint: string
      sentences: Array<{ id: string; page: number; start: number; end: number; text: string }>
    }
    expect(parsed.fingerprint).toBe(fingerprint)
    expect(parsed.sentences).toHaveLength(2)
    expect(parsed.sentences[0]).toMatchObject({ id: 's1', page: 1 })
    expect(parsed.sentences[0].text).toBe(
      text.slice(parsed.sentences[0].start, parsed.sentences[0].end),
    )
    expect(parsed.sentences[1].id).toBe('s2')
    const firstStat = await stat(target)

    const second = await postSentences(fingerprint)
    expect(second.status).toBe(200)
    await expect(second.json()).resolves.toEqual({ fingerprint, sentenceCount: 2 })

    expect(await readFile(target, 'utf8')).toBe(saved)
    const secondStat = await stat(target)
    expect(secondStat.mtimeMs).toBe(firstStat.mtimeMs)
  })

  it('answers 409 when the readable text has not been built and 404 for unknown documents', async () => {
    const known = 'c'.repeat(64)
    await mkdir(path.join(workDir, 'data', 'originals'), { recursive: true })
    await writeFile(path.join(workDir, 'data', 'originals', known), 'stored bytes', 'utf8')

    const conflict = await postSentences(known)
    expect(conflict.status).toBe(409)
    const conflictBody = (await conflict.json()) as { error?: string }
    expect(conflictBody.error).toContain('readable text')

    const missing = await postSentences('b'.repeat(64))
    expect(missing.status).toBe(404)
    const missingBody = (await missing.json()) as { error?: string }
    expect(missingBody.error).toContain('not found')
  })
})
