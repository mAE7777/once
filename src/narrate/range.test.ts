import { describe, expect, it } from 'vitest'
import { DEMO_FINGERPRINT, voicedPointIds, voicedSectionIds } from './range'
function points(n:number,len=100){return Array.from({length:n},(_,i)=>({id:`pt${i+1}`,spoken:'x'.repeat(len)}))}
function steps(n:number){return Array.from({length:n},(_,i)=>({id:`st${i+1}`,kind:'context' as const,title:'T',points:points(2,100)}))}
describe('voicedPointIds',()=>{
 it('voices opening points up to about 3000 chars',()=>{expect(voicedPointIds('b'.repeat(64),points(4,1200))).toEqual(['pt1','pt2'])})
 it('always voices at least the first point',()=>{expect(voicedPointIds('b'.repeat(64),[{id:'pt1',spoken:'x'.repeat(4000)}])).toEqual(['pt1'])})
})
describe('voicedSectionIds',()=>{
 it('voices the first 4 sections of the demo paper, through the first figure',()=>{expect(voicedSectionIds(DEMO_FINGERPRINT,steps(5))).toEqual(['st1','st2','st3','st4'])})
 it('voices opening sections of other texts to about 3000 chars',()=>{const ss=steps(4); ss.forEach(st=>st.points=[{id:'p',spoken:'x'.repeat(2000)}]); expect(voicedSectionIds('b'.repeat(64),ss)).toEqual(['st1'])})
})
