import { demoAccounts, demoService, signInAsDemoAccount } from './demo'
import type { PickupService } from './contract'

type AppServices = {
  pickup: PickupService
  demo?: {
    accounts: readonly { id: string; label: string }[]
    signIn: (id: string) => void
  }
}

export const { pickup, demo }: AppServices = {
  pickup: demoService,
  demo: { accounts: demoAccounts, signIn: signInAsDemoAccount },
}
