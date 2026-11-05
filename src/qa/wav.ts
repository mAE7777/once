export const WAV_SAMPLE_RATE = 24000

/** Averages every channel down to the single channel the speech service takes. */
export function toMono(buffer: Pick<AudioBuffer, 'numberOfChannels' | 'length' | 'getChannelData'>): Float32Array {
  const mono = new Float32Array(buffer.length)
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel)
    for (let i = 0; i < buffer.length; i++) mono[i] += data[i] / buffer.numberOfChannels
  }
  return mono
}

export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(bytes.buffer)
  const tag = (at: number, text: string) => { for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i) }
  tag(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); tag(8, 'WAVE')
  tag(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  tag(36, 'data'); view.setUint32(40, samples.length * 2, true)
  samples.forEach((sample, i) => {
    const clamped = Math.max(-1, Math.min(1, sample))
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
  })
  return bytes
}

/** MediaRecorder gives webm/opus in Chrome. The browser decodes it and resamples to the context rate, then it leaves as WAV. */
export async function recordingToWav(recording: Blob): Promise<Blob> {
  const decoder = new OfflineAudioContext(1, 1, WAV_SAMPLE_RATE)
  const decoded = await decoder.decodeAudioData(await recording.arrayBuffer())
  return new Blob([new Uint8Array(encodeWav(toMono(decoded), WAV_SAMPLE_RATE))], { type: 'audio/wav' })
}
