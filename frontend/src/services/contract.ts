import type {
  DirectoryPlayer, GameDetails, GameInput, GameSummary, InboxItem, PlayerDetails, PlayerFilters,
  Profile, AccountProfileInput, AccountDetails, GameContact, GameEdit, Response, ResultInput, ReviewInput, Session, Team, TeamAssignment,
  BrowseFilters, BrowseGame, BulkInviteResult, JoinDecision, Notification,
  NotificationPreferences, Sport, SportDefinition, Squad,
} from '../types/domain'

export interface PickupService {
  getSession(): Promise<Session | null>
  signUp(email: string, password: string): Promise<Session>
  signIn(email: string, password: string): Promise<Session>
  signOut(): Promise<void>
  getProfile(id: string): Promise<Profile | null>
  getPlayerDetails(id: string): Promise<PlayerDetails | null>
  saveProfile(input: AccountProfileInput): Promise<Profile>
  getAccountDetails(): Promise<AccountDetails>
  usernameAvailable(username: string): Promise<boolean>
  getGameContacts(gameId: string): Promise<GameContact[]>
  findPlayers(filters: PlayerFilters): Promise<DirectoryPlayer[]>
  createGame(input: GameInput): Promise<string>
  editGame(gameId: string, input: GameEdit): Promise<void>
  myGames(): Promise<GameSummary[]>
  getGame(id: string): Promise<GameDetails | null>
  invite(gameId: string, recipientId: string, team?: Team | null): Promise<string>
  inviteMany(gameId: string, recipients: string[], team?: Team | null): Promise<BulkInviteResult[]>
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
  listSports(): Promise<SportDefinition[]>
  createSport(name: string): Promise<SportDefinition>
  browseGames(filters?: BrowseFilters): Promise<BrowseGame[]>
  joinGame(gameId: string): Promise<'joined'>
  requestToJoin(gameId: string): Promise<string>
  cancelJoinRequest(requestId: string): Promise<'cancelled'>
  respondToJoinRequest(requestId: string, decision: JoinDecision, team?: Team | null): Promise<JoinDecision>
  withdraw(gameId: string): Promise<'withdrawn'>
  claimReplacement(gameId: string): Promise<'joined'>
  notifications(): Promise<Notification[]>
  markNotificationsRead(ids?: string[]): Promise<number>
  getNotificationPreferences(): Promise<NotificationPreferences>
  setNotificationPreferences(preferences: NotificationPreferences): Promise<void>
  subscribeToNotifications(listener: () => void): () => void
  mySquads(): Promise<Squad[]>
  createSquad(name: string, sport: Sport): Promise<string>
  joinSquad(code: string): Promise<string>
  leaveSquad(squadId: string): Promise<'left'>
  removeSquadMember(squadId: string, playerId: string): Promise<'removed'>
  deleteSquad(squadId: string): Promise<'deleted'>
  inviteSquad(gameId: string, squadId: string, team?: Team | null): Promise<BulkInviteResult[]>
  /** Notify readers after session changes or committed data updates. */
  subscribe(listener: () => void): () => void
}
