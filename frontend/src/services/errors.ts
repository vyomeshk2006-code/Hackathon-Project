export const errorMessages = {
  FORBIDDEN: 'You don’t have permission to do that.',
  PROFILE_REQUIRED: 'Create a player profile first.',
  VALIDATION: 'Check the information you entered.',
  TEAM_FULL: 'That team is full.',
  LEVEL_LOCKED: 'Verified levels are updated by peer ratings.',
  GAME_FULL: 'This game is full.',
  GAME_UNAVAILABLE: 'This game is no longer available for that action.',
  INVITATION_CLOSED: 'This invitation is closed.',
  RESULTS_TOO_EARLY: 'Results open on game day in Tampa.',
  TEAMS_INCOMPLETE: 'Assign every roster player to a team and put at least one player on each team.',
  RESULT_NOT_PENDING: 'There is no pending result to respond to.',
  NOT_ELIGIBLE: 'Only eligible players from a finalized game can submit this review.',
  ALREADY_REVIEWED: 'You already reviewed this player for this game.',
} as const

type ErrorCode = keyof typeof errorMessages

export class PickupError extends Error {
  constructor(readonly code: ErrorCode, message: string = errorMessages[code]) {
    super(message)
  }
}

export function requireRule(condition: unknown, code: ErrorCode, message?: string): asserts condition {
  if (!condition) throw new PickupError(code, message)
}
