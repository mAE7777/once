import type { ReadableTextItem } from '@/lib/types'

function visibleItems(items: readonly ReadableTextItem[]): ReadableTextItem[] {
  return items.filter((item) => item.str.length > 0)
}

function lineTolerance(a: ReadableTextItem, b: ReadableTextItem): number {
  const height = Math.max(Math.abs(a.h), Math.abs(b.h), 1)
  return Math.max(2, height * 0.5)
}

function groupIntoLines(items: readonly ReadableTextItem[]): ReadableTextItem[][] {
  const sorted = [...visibleItems(items)].sort((a, b) => {
    if (b.y !== a.y) return b.y - a.y
    return a.x - b.x
  })

  const lines: ReadableTextItem[][] = []
  for (const item of sorted) {
    const current = lines[lines.length - 1]
    if (current && Math.abs(item.y - current[0].y) <= lineTolerance(item, current[0])) {
      current.push(item)
    } else {
      lines.push([item])
    }
  }
  for (const line of lines) {
    line.sort((a, b) => a.x - b.x)
  }
  lines.sort((a, b) => b[0].y - a[0].y)
  return lines
}

function joinLine(line: readonly ReadableTextItem[]): string {
  let text = ''
  let prevEnd: number | null = null
  for (const item of line) {
    if (prevEnd === null) {
      text = item.str
    } else {
      const gap = item.x - prevEnd
      if (gap > 1 && !text.endsWith(' ') && !item.str.startsWith(' ')) {
        text += ` ${item.str}`
      } else {
        text += item.str
      }
    }
    prevEnd = item.x + item.w
  }
  return text
}

export function detectColumnSplit(
  items: readonly ReadableTextItem[],
  pageWidth: number,
): number | null {
  const usable = visibleItems(items).filter((item) => item.str.trim().length > 0)
  if (!Number.isFinite(pageWidth) || pageWidth <= 0 || usable.length < 4) return null

  const mid = pageWidth / 2
  const minGutter = Math.max(8, pageWidth * 0.02)
  let best: { split: number; gutter: number; distance: number } | null = null

  for (let candidate = pageWidth * 0.35; candidate <= pageWidth * 0.65; candidate += 2) {
    const left = usable.filter((item) => item.x + item.w <= candidate)
    const right = usable.filter((item) => item.x >= candidate)
    const crossing = usable.length - left.length - right.length
    if (left.length < 2 || right.length < 2) continue
    if (crossing / usable.length > 0.1) continue
    if (Math.min(left.length, right.length) / usable.length < 0.2) continue

    const leftEnd = Math.max(...left.map((item) => item.x + item.w))
    const rightStart = Math.min(...right.map((item) => item.x))
    const gutter = rightStart - leftEnd
    if (gutter < minGutter) continue

    const split = (leftEnd + rightStart) / 2
    const distance = Math.abs(split - mid)
    if (!best || gutter > best.gutter || (gutter === best.gutter && distance < best.distance)) {
      best = { split, gutter, distance }
    }
  }

  return best ? best.split : null
}

export function orderItemsForReading(
  items: readonly ReadableTextItem[],
  pageWidth = 0,
): ReadableTextItem[] {
  const width =
    pageWidth > 0
      ? pageWidth
      : Math.max(0, ...visibleItems(items).map((item) => item.x + item.w))
  const split = detectColumnSplit(items, width)
  if (split === null) {
    return groupIntoLines(items).flat()
  }
  const left = visibleItems(items).filter((item) => item.x + item.w / 2 < split)
  const right = visibleItems(items).filter((item) => item.x + item.w / 2 >= split)
  return [...groupIntoLines(left).flat(), ...groupIntoLines(right).flat()]
}

export function buildPageText(items: readonly ReadableTextItem[], pageWidth = 0): string {
  const width =
    pageWidth > 0
      ? pageWidth
      : Math.max(0, ...visibleItems(items).map((item) => item.x + item.w))
  const split = detectColumnSplit(items, width)
  if (split === null) {
    return groupIntoLines(items).map(joinLine).join('\n')
  }
  const left = visibleItems(items).filter((item) => item.x + item.w / 2 < split)
  const right = visibleItems(items).filter((item) => item.x + item.w / 2 >= split)
  const lines = [...groupIntoLines(left), ...groupIntoLines(right)]
  return lines.map(joinLine).join('\n')
}
