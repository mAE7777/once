'use client'

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <main style={{ maxWidth: 640, margin: '48px auto', padding: '0 20px', lineHeight: 1.6 }}>
      <h1 style={{ fontSize: 28, marginBottom: 8 }}>Something went wrong</h1>
      <p role="alert" style={{ color: '#b00020', marginTop: 0 }}>
        {error.message || 'The page failed to load. Please try again.'}
      </p>
      <button
        type="button"
        onClick={() => reset()}
        style={{
          padding: '8px 20px',
          border: '1px solid #222',
          borderRadius: 6,
          background: '#222',
          color: '#fff',
          cursor: 'pointer',
        }}
      >
        Try again
      </button>
    </main>
  )
}
