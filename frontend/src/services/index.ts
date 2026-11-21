import { demoAccounts, demoService, signInAsDemoAccount } from './demo'
import type { PickupService } from './contract'
import { createSupabaseAdapter } from './supabase'

// Live mode when both are set (e.g. in frontend/.env.local or Vercel env vars); demo mode otherwise.
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined

type AppServices = {
  pickup: PickupService
  demo?: {
    accounts: readonly { id: string; label: string }[]
    signIn: (id: string) => void
  }
}

export const { pickup, demo }: AppServices = url && key
  ? { pickup: createSupabaseAdapter(url, key) }
  : { pickup: demoService, demo: { accounts: demoAccounts, signIn: signInAsDemoAccount } }
