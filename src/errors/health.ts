export interface KeyHealth {
  metaKey: boolean
  elevenLabsKey: boolean
}

export function getKeyHealth(env: NodeJS.ProcessEnv = process.env): KeyHealth {
  return {
    metaKey: Boolean(env.META_API_KEY || env.MODEL_API_KEY),
    elevenLabsKey: Boolean(env.ELEVENLABS_API_KEY),
  }
}
