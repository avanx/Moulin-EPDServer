/** Secure-context / extension-safe UUID. Falls back when crypto.randomUUID is missing or broken. */
export function randomUUID(): string {
  const cryptoApi = globalThis.crypto
  if (typeof cryptoApi?.randomUUID === 'function') {
    try {
      return cryptoApi.randomUUID()
    } catch {
      // Some browser extensions replace crypto with a broken shim.
    }
  }

  if (typeof cryptoApi?.getRandomValues === 'function') {
    try {
      const bytes = new Uint8Array(16)
      cryptoApi.getRandomValues(bytes)
      bytes[6] = (bytes[6] & 0x0f) | 0x40
      bytes[8] = (bytes[8] & 0x3f) | 0x80
      const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    } catch {
      // Fall through to Math.random.
    }
  }

  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const value = (Math.random() * 16) | 0
    const digit = char === 'x' ? value : (value & 0x3) | 0x8
    return digit.toString(16)
  })
}
