import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { buildStandard, displayText, hyphenContext, lineEndHyphen } from './standard'
import { buildSentenceDocument } from '@/sentences/sentences'
import { StandardInline, findAnchor, paginate, piecesFor, slicePieces, strokeGroups, type BlockMetric } from '@/reader/StandardView'
import type { PageNote, PlanSkippable, ReadablePage, ReadableTextItem, Sentence } from '@/lib/types'

const sentences: Sentence[] = [
  { id: 's1', page: 1, start: 0, end: 10, text: 'A heading here', boxes: [] },
  { id: 's2', page: 1, start: 12, end: 40, text: 'First body sentence follows on.', boxes: [] },
]
describe('buildStandard', () => {
  it('parses markdown headings without showing markup', () => {
    const blocks = buildStandard('# A heading here\n\nFirst body sentence follows on.', sentences, 'markdown')
    expect(blocks[0]).toMatchObject({ type: 'heading', text: 'A heading here' })
    expect(JSON.stringify(blocks)).not.toContain('#')
  })
})

const LEADING = 11
const LEFT = 108
const WIDTH = 396

type Row = [text: string, options?: { gap?: number; indent?: number; h?: number; w?: number; x?: number; cells?: string[] }]

function pageOf(rows: Row[], page = 1): ReadablePage {
  const items: ReadableTextItem[] = []
  let y = 700
  for (const [text, options = {}] of rows) {
    y -= options.gap ?? LEADING
    const x = options.x ?? LEFT + (options.indent ?? 0)
    if (options.cells) {
      options.cells.forEach((cell, i) => items.push({ str: cell, x: x + i * 90, y, w: 40, h: options.h ?? 10 }))
    } else {
      items.push({ str: text, x, y, w: options.w ?? WIDTH - (options.indent ?? 0), h: options.h ?? 10 })
    }
  }
  const text = rows.map(([row, options]) => (options?.cells ? options.cells.join(' ') : row)).join('\n')
  return { page, width: 612, height: 792, text, items, isScan: false }
}

function layout(pages: ReadablePage[], skippable: PlanSkippable[] = []) {
  const { sentences: stored } = buildSentenceDocument({ fingerprint: 'f', kind: 'pdf', pageCount: pages.length, fullText: pages.map((p) => p.text).join('\n'), pages })
  return { stored, blocks: buildStandard('', stored, 'pdf', { pages, skippable }) }
}

const placedIds = (blocks: ReturnType<typeof buildStandard>) => new Set(blocks.flatMap((b) => b.sentenceIds))

describe('structure from page geometry', () => {
  const page = pageOf([
    ['This first paragraph opens the section and it runs along the whole width of the page.'],
    ['It closes here with a full stop on its second line of type.'],
    ['This second paragraph follows a larger gap than normal line spacing would ever leave.', { gap: 17 }],
    ['It also ends at a full stop.'],
    ['2 Background', { gap: 24, h: 12, w: 70 }],
    ['The goal of this part is told after the heading and it is a body line again here.', { gap: 24 }],
    ['It ends with a stop too.'],
    ['An indented line starts another paragraph without any extra vertical space at all.', { indent: 18 }],
    ['3.1 Encoder Stacks', { gap: 24, h: 10, w: 90 }],
    ['Body text carries on below the numbered heading across the width of the whole page.', { gap: 20 }],
  ])

  it('breaks paragraphs at a larger gap and at a first-line indent', () => {
    const { blocks } = layout([page])
    const paragraphs = blocks.filter((b) => b.type === 'paragraph').map((b) => b.text)
    expect(paragraphs[0]).toBe('This first paragraph opens the section and it runs along the whole width of the page. It closes here with a full stop on its second line of type.')
    expect(paragraphs[1]).toMatch(/^This second paragraph/)
    expect(paragraphs[2]).toMatch(/^The goal of this part/)
    expect(paragraphs[3]).toMatch(/^An indented line/)
    expect(paragraphs).toHaveLength(5)
  })

  it('sets numbered lines as headings that do not run into paragraphs, even inside one sentence', () => {
    const { blocks, stored } = layout([page])
    const headings = blocks.filter((b) => b.type === 'heading')
    expect(headings.map((h) => [h.text, h.level])).toEqual([['2 Background', 1], ['3.1 Encoder Stacks', 2]])
    expect(stored.length).toBeGreaterThan(0)
  })

  it('splits one sentence across a heading and its neighbour, with both parts lit by the same id', () => {
    const { blocks, stored } = layout([pageOf([
      ['In this fixture a first line of ordinary body text runs across the page and on,'],
      ['and a second one of the same kind sets the normal spacing between lines, and'],
      ['to counteract this effect we scale the dot products by a factor across the page of'],
      ['3.2 Multi-Head Attention', { gap: 24, w: 120 }],
      ['Instead we project the queries across the whole width of the page with a stop here.', { gap: 24 }],
    ])])
    const fused = stored.find((s) => s.text.includes('3.2 Multi-Head Attention'))!
    expect(fused.text).toContain('factor across the page of\n3.2')
    expect(blocks.find((b) => b.type === 'heading')).toMatchObject({ text: '3.2 Multi-Head Attention', sentenceIds: [fused.id] })
    expect(blocks[0].sentenceIds).toContain(fused.id)
    expect(blocks[0].text).not.toContain('3.2')
  })

  it('sets a short larger line as a heading', () => {
    const { blocks } = layout([pageOf([
      ['Attention Is Everything', { h: 17, w: 180 }],
      ['A body line sits a long way under the title across the full width of the page here.', { gap: 30 }],
      ['Another body line closes the fixture with a plain ending and a stop on it now.'],
      ['One more body line keeps the most common type size clear for this small fixture.'],
    ])])
    expect(blocks[0]).toMatchObject({ type: 'heading', level: 1, text: 'Attention Is Everything' })
  })

  it('does not read a numbered prose line without a gap as a heading', () => {
    const { blocks } = layout([pageOf([
      ['The batch held many examples for the run across the whole width of the page today,'],
      ['2 Aug was the day the second run began'],
      ['and it carried on for three more days across the whole width of the page as planned.'],
    ])])
    expect(blocks.filter((b) => b.type === 'heading')).toEqual([])
    expect(blocks).toHaveLength(1)
  })

  it('carries a paragraph over a page break, past a caption', () => {
    const { blocks } = layout([
      pageOf([['The output is computed as a weighted sum running across the width of the page']]),
      pageOf([
        ['Figure 2: Two kinds of attention.', { w: 200 }],
        ['of the values, where each weight comes from a function that reads across the page.', { gap: 20 }],
      ], 2),
    ])
    expect(blocks[0].type).toBe('paragraph')
    expect(blocks[0].text).toBe('The output is computed as a weighted sum running across the width of the page of the values, where each weight comes from a function that reads across the page.')
    expect(blocks[1]).toMatchObject({ type: 'caption', text: 'Figure 2: Two kinds of attention.' })
  })
})

describe('line-end hyphens', () => {
  const context = hyphenContext(['the encoder-decoder design and transduction work on a sequence model. A source and a target.'])

  it('joins a broken lowercase word', () => {
    expect(lineEndHyphen('transduc-', 'tion models', context)).toBe('join')
    expect(displayText('and transduc-\ntion models', context)).toBe('and transduction models')
  })

  it('keeps the hyphen of a compound seen elsewhere in the text', () => {
    expect(lineEndHyphen('encoder-', 'decoder', context)).toBe('keep')
    expect(displayText('an encoder-\ndecoder model', context)).toBe('an encoder-decoder model')
  })

  it('keeps the hyphen when the first part is a word of its own and the joined word is unknown', () => {
    expect(displayText('the sequence-\naligned models', context)).toBe('the sequence-aligned models')
    expect(displayText('a source-\ntarget pair', context)).toBe('a source-target pair')
  })

  it('still joins when the second part is only a word ending', () => {
    expect(displayText('a model-\ning choice', hyphenContext(['a model here']))).toBe('a modeling choice')
  })

  it('leaves capitalised continuations and longer compounds alone', () => {
    expect(displayText('the Berkeley-\nParser', context)).toBe('the Berkeley-Parser')
    expect(displayText('the state-of-the-\nart result', context)).toBe('the state-of-the-art result')
  })

  it('does not count the broken pieces themselves as words', () => {
    const own = hyphenContext(['sequence transduc-\ntion'])
    expect(own.words.has('transduc')).toBe(false)
    expect(own.words.has('tion')).toBe(false)
  })

  it('shows the joined word in the layout and leaves the stored sentence alone', () => {
    const { blocks, stored } = layout([pageOf([
      ['Attention has become a key part of sequence modeling and many transduc-'],
      ['tion models in many tasks, and this line runs along the full page width too.'],
    ])])
    expect(blocks[0].text).toContain('transduction models')
    expect(stored[0].text).toContain('transduc-\ntion')
    const copy = JSON.parse(JSON.stringify(stored)) as Sentence[]
    buildStandard('', stored, 'pdf', { pages: [pageOf([['x']])] })
    expect(stored).toEqual(copy)
  })
})

describe('what stays on the sheets', () => {
  const skip = (sentenceId: string, reason: string): PlanSkippable => ({ sentenceId, reason })

  it('keeps every sentence, with stored spans unchanged', () => {
    const pages = [pageOf([
      ['One sentence opens this fixture across the width of the page. A second one follows.'],
      ['A third one closes the first paragraph of the fixture page.'],
      ['Another paragraph goes on here after a gap, and it is the last one on the page.', { gap: 20 }],
    ])]
    const { stored, blocks } = layout(pages)
    expect(stored.length).toBeGreaterThan(2)
    expect(placedIds(blocks)).toEqual(new Set(stored.map((s) => s.id)))
    for (const s of stored) expect(pages[0].text.slice(s.start, s.end)).toBe(s.text)
  })

  it('leaves out only page numbers and figure labels the plan marks, and keeps references', () => {
    const pages = [pageOf([
      ['Scaled Attention Multi Head', { w: 150, x: 200 }],
      ['A real paragraph sits on this page across the whole width of the printed text area.', { gap: 40 }],
      ['[1] Jimmy Ba and Geoffrey Hinton wrote a paper about layer normalization long ago.', { gap: 20 }],
      ['2', { gap: 40, w: 6, x: 300 }],
    ])]
    const { stored } = layout(pages)
    const labels = stored.find((s) => s.text.startsWith('Scaled'))!
    const reference = stored.find((s) => s.text.startsWith('[1]'))!
    const number = stored.find((s) => s.text === '2')!
    const { blocks } = layout(pages, [
      skip(labels.id, 'stray labels from inside figure'),
      skip(number.id, 'page number with no content'),
      skip(reference.id, 'references'),
    ])
    const placed = placedIds(blocks)
    expect(placed.has(labels.id)).toBe(false)
    expect(placed.has(number.id)).toBe(false)
    expect(placed.has(reference.id)).toBe(true)
    expect(JSON.stringify(blocks)).not.toContain('Scaled')
  })

  it('keeps a skippable sentence the plan gives another reason for', () => {
    const pages = [pageOf([['Acknowledgements go to many kind colleagues who read this across the page width.']])]
    const { stored } = layout(pages)
    const { blocks } = layout(pages, [skip(stored[0].id, 'acknowledgements')])
    expect(placedIds(blocks).has(stored[0].id)).toBe(true)
  })

  it('keeps a figure caption the plan skips, since it is not a word list', () => {
    const pages = [pageOf([['Figure 1: The whole model.', { w: 150 }]])]
    const { stored } = layout(pages)
    const { blocks } = layout(pages, [skip(stored[0].id, 'text from inside figure')])
    expect(placedIds(blocks).has(stored[0].id)).toBe(true)
  })

  it('keeps a page number the plan does not mark, set small as a folio', () => {
    const { blocks, stored } = layout([pageOf([
      ['The output is computed as a weighted sum running across the width of the page', { gap: 11 }],
      ['3', { gap: 50, w: 6, x: 300 }],
    ])])
    expect(placedIds(blocks)).toEqual(new Set(stored.map((s) => s.id)))
    expect(blocks[blocks.length - 1]).toMatchObject({ type: 'folio', text: '3' })
    expect(blocks[0].text).not.toMatch(/ 3$/)
  })

  it('takes a fused page number away only when its sentence is skippable', () => {
    const pages = [pageOf([
      ['[7] Junyoung Chung wrote a paper about gated networks and it runs along the page', { gap: 11 }],
      ['10', { gap: 50, w: 6, x: 300 }],
    ])]
    const { stored } = layout(pages)
    expect(stored).toHaveLength(1)
    const { blocks } = layout(pages, [skip(stored[0].id, 'references')])
    expect(placedIds(blocks).has(stored[0].id)).toBe(true)
    expect(blocks.map((b) => b.text).join(' ')).not.toMatch(/\b10\b/)
  })

  it('leaves table rows out but keeps prose and any sentence with prose in it', () => {
    const { blocks, stored } = layout([pageOf([
      ['Table 3: Variations on the model.', { w: 200 }],
      ['train PPL BLEU params', { gap: 20, cells: ['train', 'PPL', 'BLEU', 'params'] }],
      ['base 6 512 2048', { cells: ['base', '6', '512', '2048'] }],
      ['1 512 512 5.29', { cells: ['1', '512', '512', '5.29'] }],
      ['big 6 1024 4096', { cells: ['big', '6', '1024', '4096'] }],
      ['development set, newstest2013 was used for all of these across the width of the page.', { gap: 20 }],
    ])])
    const all = blocks.map((b) => b.text).join('\n')
    expect(all).not.toContain('5.29')
    expect(all).not.toContain('train PPL')
    expect(all).toContain('development set')
    const prose = stored.find((s) => s.text.includes('development set'))!
    expect(placedIds(blocks).has(prose.id)).toBe(true)
    expect(prose.text).toContain('5.29')
  })

  it('leaves out labels drawn inside a figure even when a caption shares their sentence', () => {
    const page = pageOf([
      ['Scaled', { w: 40, x: 200 }],
      ['Attention', { w: 40, x: 240, gap: 30 }],
      ['Figure 4: Two attention heads, also in layer 5 of 6, reading across the whole page.', { gap: 40 }],
      ['Body text follows the figure here across the whole width of the printed text area.', { gap: 20 }],
    ])
    page.items.unshift(
      { str: 'The', x: 130, y: 720, w: 16, h: 9 },
      { str: 'Law', x: 144, y: 720, w: 17, h: 9 },
      { str: 'will', x: 158, y: 720, w: 13, h: 9 },
    )
    page.text = `TheLawwill\n${page.text}`
    const { blocks, stored } = layout([page])
    const all = blocks.map((b) => b.text).join('\n')
    expect(all).not.toContain('TheLaw')
    expect(all).not.toContain('Scaled')
    expect(all).toContain('Figure 4: Two attention heads')
    const caption = stored.find((s) => s.text.includes('Figure 4'))!
    expect(placedIds(blocks).has(caption.id)).toBe(true)
  })

  it('still reaches every sentence when text cannot be matched to a chunk', () => {
    const blocks = buildStandard('Other words altogether.', [{ id: 'x', page: 1, start: 0, end: 5, text: 'Never in the text', boxes: [] }], 'text')
    expect(placedIds(blocks).has('x')).toBe(true)
  })
})

const note = (sentenceId: string, anchor: string): PageNote => ({ id: `n-${anchor}`, sentenceId, anchor, note: 'n', start: 0, end: 0, boxes: [] })

describe('the lit stroke', () => {
  const lit = (ids: string[]) => (id: string) => (ids.includes(id) ? 'lit' as const : null)
  const runs = [{ id: 'a', text: 'the Extended Neural GPU' }, { text: ' ' }, { id: 'b', text: '[16], ByteNet and more.' }]

  it('runs across the space between two lit sentences as one group', () => {
    const groups = strokeGroups(piecesFor(runs, []), lit(['a', 'b']))
    expect(groups).toHaveLength(1)
    expect(groups[0].state).toBe('lit')
    expect(groups[0].pieces.map((p) => p.text).join('')).toBe('the Extended Neural GPU [16], ByteNet and more.')
  })

  it('stays one painted element across a note anchor', () => {
    const html = renderToStaticMarkup(createElement(StandardInline, {
      pieces: piecesFor(runs, [note('a', 'Neural GPU')]),
      stateOf: lit(['a', 'b']),
      onNote: () => {},
    }))
    expect(html.match(/std-lit/g)).toHaveLength(1)
    expect(html).toContain('std-note')
    expect(html.replace(/<[^>]+>/g, '')).toBe('the Extended Neural GPU [16], ByteNet and more.')
  })

  it('stops at the edge of what is lit', () => {
    const groups = strokeGroups(piecesFor(runs, []), lit(['a']))
    expect(groups.map((g) => g.state)).toEqual(['lit', null, null])
  })
})

describe('note anchors in display text', () => {
  it('underlines the same words across a line break or a joined word', () => {
    expect(findAnchor('a sequence transduction model', 'sequence transduction')).toEqual({ at: 2, length: 21 })
    expect(findAnchor('in transduction work', 'transduc- tion')).toEqual({ at: 3, length: 12 })
    expect(findAnchor('nothing here', 'absent')).toBeNull()
  })

  it('covers the anchor exactly once, and keeps all words', () => {
    const pieces = piecesFor([{ id: 'a', text: 'mask with masking and masking' }], [note('a', 'masking')])
    expect(pieces.filter((p) => p.note).map((p) => p.text)).toEqual(['masking'])
    expect(pieces.map((p) => p.text).join('')).toBe('mask with masking and masking')
  })

  it('keeps the underline on both sides when a sheet splits the anchor', () => {
    const pieces = piecesFor([{ id: 'a', text: 'one two three four' }], [note('a', 'two three')])
    const before = slicePieces(pieces, 0, 8)
    const after = slicePieces(pieces, 8, 18)
    expect(before.map((p) => p.text).join('') + after.map((p) => p.text).join('')).toBe('one two three four')
    expect(before[before.length - 1].note).toBeDefined()
    expect(after[0].note).toBeDefined()
  })
})

function metric(lines: number, kind: BlockMetric['kind'] = 'text'): BlockMetric {
  const lineStarts = Array.from({ length: lines }, (_, i) => i * 10)
  return { kind, height: lines * 20, marginTop: kind === 'heading' ? 20 : 0, marginBottom: 10, lineHeight: 20, lineStarts, length: lines * 10 }
}

describe('sheets', () => {
  it('fills fixed sheets and keeps every character of every block once', () => {
    const metrics = [metric(6), metric(30), metric(4), metric(12)]
    const sheets = paginate(metrics, 200)
    expect(sheets.length).toBeGreaterThan(1)
    for (let b = 0; b < metrics.length; b += 1) {
      const parts = sheets.flat().filter((f) => f.block === b)
      expect(parts[0].from).toBe(0)
      expect(parts[parts.length - 1].to).toBe(metrics[b].length)
      for (let i = 1; i < parts.length; i += 1) expect(parts[i].from).toBe(parts[i - 1].to)
    }
  })

  it('never overfills a sheet', () => {
    const metrics = [metric(6), metric(30), metric(4), metric(2, 'heading'), metric(12)]
    for (const sheet of paginate(metrics, 200)) {
      const lines = sheet.reduce((sum, f) => sum + metrics[f.block].lineStarts.filter((s) => s >= f.from && s < f.to).length, 0)
      expect(lines * 20).toBeLessThanOrEqual(200)
    }
  })

  it('leaves at least two lines on each side of a split', () => {
    const metrics = [metric(7), metric(5)]
    const parts = paginate(metrics, 200).flat().filter((f) => f.block === 1)
    expect(parts).toHaveLength(2)
    expect(parts[0].to / 10).toBeGreaterThanOrEqual(2)
    expect((metrics[1].length - parts[1].from) / 10).toBeGreaterThanOrEqual(2)
    expect(parts[0].continues).toBe(true)
    expect(parts[1].continued).toBe(true)
  })

  it('does not strand a heading at the foot of a sheet', () => {
    const sheets = paginate([metric(8), metric(1, 'heading'), metric(4)], 200)
    expect(sheets[0].map((f) => f.block)).toEqual([0])
    expect(sheets[1][0].block).toBe(1)
    expect(sheets[1][1].block).toBe(2)
  })

  it('moves on even when one line is taller than the sheet', () => {
    const sheets = paginate([metric(1), metric(3)], 10)
    expect(sheets.flat().map((f) => f.block)).toEqual([0, 1, 1, 1])
  })
})
