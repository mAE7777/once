import { afterEach, describe, expect, it, vi } from 'vitest'
import { WAV_SAMPLE_RATE, encodeWav, recordingToWav, toMono } from './wav'

afterEach(() => { vi.unstubAllGlobals() })

describe('encodeWav', () => {
  it('writes a canonical mono 16-bit header and little-endian samples', () => {
    const bytes = encodeWav(new Float32Array([0, 1, -1, 2]), 24000)
    const view = new DataView(bytes.buffer)
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('RIFF'); expect(String.fromCharCode(...bytes.slice(8, 12))).toBe('WAVE')
    expect(view.getUint32(4, true)).toBe(36 + 8); expect(view.getUint16(20, true)).toBe(1); expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(24000); expect(view.getUint32(28, true)).toBe(48000); expect(view.getUint16(32, true)).toBe(2); expect(view.getUint16(34, true)).toBe(16)
    expect(String.fromCharCode(...bytes.slice(36, 40))).toBe('data'); expect(view.getUint32(40, true)).toBe(8)
    expect([view.getInt16(44, true), view.getInt16(46, true), view.getInt16(48, true), view.getInt16(50, true)]).toEqual([0, 32767, -32768, 32767])
  })
})

describe('toMono', () => {
  it('averages the channels', () => {
    const channels = [new Float32Array([1, 0.5]), new Float32Array([0, 0.5])]
    expect(Array.from(toMono({ numberOfChannels: 2, length: 2, getChannelData: (i: number) => channels[i] }))).toEqual([0.5, 0.5])
  })
})

describe('recordingToWav', () => {
  it('decodes the recording at the target rate and returns WAV', async () => {
    const seen: number[] = []
    class FakeContext {
      constructor(_channels: number, _length: number, rate: number) { seen.push(rate) }
      async decodeAudioData() { return { numberOfChannels: 1, length: 3, getChannelData: () => new Float32Array([0, 0.5, -0.5]) } }
    }
    vi.stubGlobal('OfflineAudioContext', FakeContext)
    const wav = await recordingToWav(new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }))
    expect(seen).toEqual([WAV_SAMPLE_RATE]); expect(wav.type).toBe('audio/wav')
    expect(wav.size).toBe(44 + 6)
  })
  it('passes a decode failure back to the caller', async () => {
    vi.stubGlobal('OfflineAudioContext', class { async decodeAudioData() { throw new Error('bad audio') } })
    await expect(recordingToWav(new Blob([new Uint8Array([1])]))).rejects.toThrow('bad audio')
  })
})
