import type { TextLanguage } from '@/lib/types'
const MIN_HAN_SHARE = 0.2
const MIN_FUNCTION_WORD_SHARE = 0.15
const ENGLISH_FUNCTION_WORDS = new Set(['the','of','and','to','a','an','in','on','or','as','is','are','was','were','be','been','that','this','these','those','for','with','from','by','at','it','its','not','but','which','who','what','when','where','how','why','have','has','had','they','their','them','we','our','you','your','he','his','she','her','can','could','will','would','should','may','than','then','there','each','both','such','into','over','also','about','between','through'])
function shareOf(c:number,t:number){return t===0?0:c/t}
export function detectTextLanguage(sentences: readonly {text:string}[]): TextLanguage {
  const text=sentences.map(s=>s.text).join(' ')
  const letters=text.match(/\p{L}/gu)?.length??0
  const han=text.match(/\p{Script=Han}/gu)?.length??0
  if(shareOf(han,letters)>=MIN_HAN_SHARE) return 'other'
  const words=text.toLowerCase().match(/\p{L}+/gu)??[]
  const fw=words.filter(w=>ENGLISH_FUNCTION_WORDS.has(w)).length
  return shareOf(fw,words.length)>=MIN_FUNCTION_WORD_SHARE?'en':'other'
}
export class NonEnglishTextError extends Error{constructor(){super('This text is not in English. Once currently explains English texts only, so this text was not processed.');this.name='NonEnglishTextError'}}
