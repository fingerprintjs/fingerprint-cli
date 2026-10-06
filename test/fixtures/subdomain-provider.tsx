import { FingerprintProvider } from '@fingerprint/react'

export function App() {
  return (
    <FingerprintProvider
      apiKey={import.meta.env.VITE_FINGERPRINT_PUBLIC_API_KEY}
      endpoints={import.meta.env.VITE_FINGERPRINT_ENDPOINTS ? [import.meta.env.VITE_FINGERPRINT_ENDPOINTS] : undefined}
    >
      <main>Example app</main>
    </FingerprintProvider>
  )
}
