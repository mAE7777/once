import type { PlanCheckFinding } from '@/lib/types'

export interface NarrationPoint {
  pointId: string
  text: string
}

export type LintKind =
  | 'letter-variable'
  | 'signpost'
  | 'describes-the-text'
  | 'formula-talk'
  | 'unused-name'
  | 'markup'

function finding(pointId: string, kind: LintKind, detail: string): PlanCheckFinding {
  return { pointId, kind, detail }
}

// Lower-case letters standing alone are variables in speech; "a" and "i" are left out because
// "a" is a word and a lone "i" is almost always a typing slip the listener catches anyway.
const LONE_LOWERCASE = /(?<![\p{L}\p{N}'’.-])[b-hj-z](?![\p{L}\p{N}'’-])(?!\.\p{L})/gu

// Capitals name things in ordinary speech (Plan B, C major), so only arithmetic around one counts.
const CAPITAL_IN_ARITHMETIC =
  /(?:\b(?:times|plus|minus|equals|over|by|size|length|number|value)\s+[A-Z]\b(?![\p{L}'’.-]))|(?:(?<![\p{L}'’.-])[A-Z]\s+(?:squared|cubed|times|plus|minus|equals|divided)\b)/gu

const SIGNPOSTS: readonly RegExp[] = [
  /\b(?:explain|come back to|return to|get to|talk about|cover|discuss|look at|see)\b[^.?!]{0,40}\blater\b/i,
  /\blater (?:on )?(?:we|you|i)\b/i,
  /\b(?:we|i)(?:'|’)ll\b/i,
  /\b(?:we|i) will (?:see|explain|come|return|get|look|talk|cover|discuss)\b/i,
  /\byou(?:'|’)ll (?:see|learn|find out|discover)\b/i,
  /\byou will (?:see|learn|find out|discover)\b/i,
  /\bfor now\b/i,
  /\b(?:do not|don(?:'|’)t) worry\b/i,
  /\bleave (?:that|this|it) (?:aside|open|for)\b/i,
  /\bset (?:that|this) aside\b/i,
  /\b(?:keep|hold) (?:this|that) in mind\b/i,
  /\bremember this\b/i,
  /\bmatters? later\b/i,
  /\bmore on (?:this|that)\b/i,
  /\bcoming up\b/i,
  /\bstay tuned\b/i,
  /\bnext(?:,)? (?:we|you|let(?:'|’)s)\b/i,
  /\blet(?:'|’)s (?:look at|turn to|start with|move on|begin|dive|explore)\b/i,
  /\bthere are (?:two|three|four|five|six) (?:things|ideas|points|steps|parts|lessons)\b/i,
  /\bthis is (?:the )?(?:hard|important|surprising|interesting|tricky|key)\b/i,
  /\b(?:here(?:'|’)s|here is) (?:the (?:twist|catch|surprise|key|thing)|where it gets)\b/i,
  /\bbut (?:here(?:'|’)s|there(?:'|’)s) (?:the|a) (?:twist|catch)\b/i,
  /\bwhat (?:happens|comes) next\b/i,
]

const DESCRIBES_THE_TEXT: readonly RegExp[] = [
  /\bthis (?:section|chapter|part of the (?:paper|text|article|essay|report|opinion))\b/i,
  /\bthe (?:next|previous|following|last|final|first|second|third) (?:section|chapter|paragraph)\b/i,
  /\bsection \d/i,
  /\bthe rest of (?:the|this) (?:paper|text|article|essay|report|opinion|post|book)\b/i,
  /\b(?:paper|text|article|essay|report|opinion|post|book) is (?:organi[sz]ed|structured|laid out|divided)\b/i,
  /\b(?:authors?|writer|paper|article|essay|report) (?:then|goes on|go on|next) (?:to )?(?:turns?|describes?|presents?|discuss(?:es)?|shows?|moves?)\b/i,
  /\bin (?:this|the) (?:outline|plan|explanation|section)\b/i,
  /\bthe lit (?:sentence|line|phrase|words?)\b/i,
]

const FORMULA_TALK: readonly RegExp[] = [
  /\bgrows? like\b/i,
  /\bscales? (?:as|like|with the square)\b/i,
  /\bproportional to\b/i,
  /\bsquare root of\b/i,
  /\bto the power of\b/i,
  /\b(?:the )?log(?:arithm)? of\b/i,
  /\bsubscript\b/i,
  /\bsuperscript\b/i,
  /\bbig o\b/i,
  /\bdot product\b/i,
  /\bthe formula (?:says|is|reads|gives)\b/i,
  /\bthe equation (?:says|is|reads|gives)\b/i,
]

const MARKUP = /(\$[^$\s][^$]*\$|\\[a-z]{2,}|\*\*|`|^#{1,6}\s|\bs\d+\b|\bpt\d+\b)/im

const NAME_INTRODUCTIONS =
  /\b(?:calls? (?:this|that|it|these|those|them)|is called|are called|was called|were called|known as|the term|the name|named)\s+(?:(?:a|an|the)\s+)?[“"']?([\p{L}\p{N}-]+(?:\s+[\p{L}\p{N}-]+){0,3})/giu

const NAME_STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'for', 'of', 'to', 'by', 'at', 'with', 'from',
  'is', 'are', 'was', 'were', 'that', 'this', 'it', 'because', 'when', 'after', 'before', 'which',
])

function nameWords(captured: string): string[] {
  const words: string[] = []
  for (const word of captured.split(/\s+/)) {
    const lowered = word.toLowerCase()
    if (NAME_STOP_WORDS.has(lowered)) break
    words.push(lowered)
  }
  return words
}

function stem(word: string): string {
  return word.replace(/(?:ies|es|s|ing|ed)$/, '') || word
}

function mentions(text: string, words: readonly string[]): boolean {
  const lowered = text.toLowerCase()
  return words.some((word) => word.length > 2 && lowered.includes(stem(word)))
}

/** Checks that need no model. Each finding names the point and quotes what tripped it. */
export function lintNarration(points: readonly NarrationPoint[]): PlanCheckFinding[] {
  const findings: PlanCheckFinding[] = []
  points.forEach((point, index) => {
    const { pointId, text } = point
    for (const match of text.matchAll(LONE_LOWERCASE)) {
      findings.push(finding(pointId, 'letter-variable', `"${match[0]}" is a letter used as a variable.`))
    }
    for (const match of text.matchAll(CAPITAL_IN_ARITHMETIC)) {
      findings.push(finding(pointId, 'letter-variable', `"${match[0]}" is a letter used in arithmetic.`))
    }
    for (const pattern of SIGNPOSTS) {
      const match = pattern.exec(text)
      if (match) findings.push(finding(pointId, 'signpost', `"${match[0]}" points elsewhere instead of explaining now.`))
    }
    for (const pattern of DESCRIBES_THE_TEXT) {
      const match = pattern.exec(text)
      if (match) findings.push(finding(pointId, 'describes-the-text', `"${match[0]}" describes the text or the explanation itself.`))
    }
    for (const pattern of FORMULA_TALK) {
      const match = pattern.exec(text)
      if (match) findings.push(finding(pointId, 'formula-talk', `"${match[0]}" is formula talk; give real numbers instead.`))
    }
    const markup = MARKUP.exec(text)
    if (markup) findings.push(finding(pointId, 'markup', `"${markup[0]}" cannot be read aloud.`))

    const afterwards = points.slice(index + 1).map((later) => later.text).join(' ')
    for (const match of text.matchAll(NAME_INTRODUCTIONS)) {
      const words = nameWords(match[1])
      if (words.length === 0) continue
      const rest = text.slice((match.index ?? 0) + match[0].length)
      if (!mentions(`${rest} ${afterwards}`, words)) {
        findings.push(finding(pointId, 'unused-name', `"${words.join(' ')}" is named once and never used again.`))
      }
    }
  })
  return findings
}
