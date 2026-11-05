import { describe, expect, it } from 'vitest'
import { detectTextLanguage } from './language'
function s(...t:string[]){return t.map(text=>({text}))}
describe('detectTextLanguage',()=>{
 it('recognizes English',()=>{expect(detectTextLanguage(s('The dominant sequence transduction models are based on complex recurrent networks.','We propose a new simple network architecture, based solely on attention mechanisms.'))).toBe('en')})
 it('marks Chinese as other',()=>{expect(detectTextLanguage(s('\u4eca\u5929\u6211\u4eec\u8ba8\u8bba\u4e00\u7bc7\u5173\u4e8e\u8bed\u8a00\u6a21\u578b\u7684\u8bba\u6587\u3002'))).toBe('other')})
 it('leaves French as other',()=>{expect(detectTextLanguage(s('Les modèles dominants reposent sur des réseaux récurrents complexes.'))).toBe('other')})
 it('calls text with no words other',()=>{expect(detectTextLanguage(s('123 456'))).toBe('other'); expect(detectTextLanguage([])).toBe('other')})
})
