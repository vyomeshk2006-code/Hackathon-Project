import type {
  DirectoryPlayer, GameDetails, GameInput, GameSummary, InboxItem, PlayerDetails, PlayerFilters,
  Profile, ProfileInput, Response, ResultInput, ReviewInput, Session, Team, TeamAssignment,
} from '../types/domain'

export interface PickupService {
  getSession(): Promise<Session | null>
  signUp(email: string, password: string): Promise<Session>
  signIn(email: string, password: string): Promise<Session>
  signOut(): Promise<void>
  getProfile(id: string): Promise<Profile | null>
  getPlayerDetails(id: string): Promise<PlayerDetails | null>
  saveProfile(input: ProfileInput): Promise<Profile>
  findPlayers(filters: PlayerFilters): Promise<DirectoryPlayer[]>
  createGame(input: GameInput): Promise<string>
  myGames(): Promise<GameSummary[]>
  getGame(id: string): Promise<GameDetails | null>
  invite(gameId: string, recipientId: string): Promise<string>
  inbox(): Promise<InboxItem[]>
  respond(invitationId: string, response: Response): Promise<Response>
  cancelInvitation(invitationId: string): Promise<'cancelled'>
  cancelGame(gameId: string): Promise<'cancelled'>
  setTeam(gameId: string, playerId: string, team: Team | null): Promise<Team | null>
  autoAssignTeams(gameId: string): Promise<TeamAssignment[]>
  submitResults(gameId: string, input: ResultInput): Promise<'pending'>
  confirmResults(gameId: string): Promise<'final'>
  disputeResults(gameId: string, reason: string): Promise<'disputed'>
  submitReview(gameId: string, input: ReviewInput): Promise<string>
  /** Notify readers after session changes or committed data updates. */
  subscribe(listener: () => void): () => void
}
