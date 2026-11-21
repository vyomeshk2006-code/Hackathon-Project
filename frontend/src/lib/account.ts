
export function normalizeUsername(value: string) {
  const name = value.trim()
  return /^[A-Za-z0-9_]{3,20}$/.test(name) ? name.toLowerCase() : null
}

export function normalizePhone(value: string) {
  const input = value.trim()
  if (!/^\+[\d .()-]+$/.test(input)) return null
  const digits = input.replace(/[^\d+]/g, '')
  return /^\+[1-9]\d{6,14}$/.test(digits) ? digits : null
}
