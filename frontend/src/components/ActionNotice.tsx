import { Notice } from './ui'

export function ActionNotice({ pending, error, message }: { pending: boolean; error: string; message: string }) {
  if (error) return <Notice tone="error">{error}</Notice>
  if (message) return <Notice tone="success">{message}</Notice>
  return pending ? <Notice>Saving…</Notice> : null
}
