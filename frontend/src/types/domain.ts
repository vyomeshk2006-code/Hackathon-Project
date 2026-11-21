export const sports = {
  soccer: 'Soccer', basketball: 'Basketball', cricket: 'Cricket', volleyball: 'Volleyball',
  tennis: 'Tennis', badminton: 'Badminton', pickleball: 'Pickleball', 'american-football': 'American Football',
  baseball: 'Baseball', 'table-tennis': 'Table Tennis', futsal: 'Futsal', handball: 'Handball', 'ultimate-frisbee': 'Ultimate Frisbee',
} as const

export type SportDefinition = { slug: string; name: string; fields: readonly string[] }

export const neighborhoods = {
  downtown: 'Downtown',
  'seminole-heights': 'Seminole Heights',
  'south-tampa': 'South Tampa',
  usf: 'USF Area',
  'west-tampa': 'West Tampa',
  'other-tampa': 'Other Tampa Area',
} as const

export const skills = {
  beginner: 'Beginner',
  intermediate: 'Intermediate',
  advanced: 'Advanced',
} as const

export type Sport = string
export type Neighborhood = keyof typeof neighborhoods
export type Skill = keyof typeof skills
export type StatField = 'goals' | 'assists' | 'points'
const individualStats: Record<string, readonly string[]> = {
  soccer: ['goals', 'assists'], basketball: ['points', 'rebounds', 'assists'], cricket: ['runs', 'wickets'],
  volleyball: ['points', 'aces', 'blocks'], tennis: ['sets_won'], badminton: ['sets_won'],
}
export const seededSports: SportDefinition[] = Object.entries(sports).map(([slug, name]) => ({
  slug, name, fields: individualStats[slug] ?? [],
}))

export const defaultPreferences = { replacementAlerts: true, newGameAlerts: false }
export type NotificationPreferences = typeof defaultPreferences
export type Visibility = 'open' | 'invite_only'

export function sportName(slug: string, catalog: readonly SportDefinition[] = seededSports) {
  return catalog.find(sport => sport.slug === slug)?.name ?? slug.replaceAll('-', ' ')
}

export const statLabel = (field: string) => field.replaceAll('_', ' ').replace(/^./, letter => letter.toUpperCase())
export type Team = 'A' | 'B'
export type TeamAssignment = { playerId: string; team: Team | null }
export type Outcome = 'win' | 'loss' | 'draw'
export type ResultStatus = 'pending' | 'final' | 'disputed'
export type Preference = { sport: Sport; skill: Skill; levelSource?: 'self' | 'verified'; ratingCount?: number }
export type ProfileInput = {
  displayName: string
  neighborhood: Neighborhood
  travelRadiusMiles: number
  bio: string
  sports: Preference[]
  notificationPreferences?: NotificationPreferences
}
export type Profile = ProfileInput & { id: string }
export type GameInput = {
  sport: Sport
  title: string
  venue: string
  neighborhood: Neighborhood
  startsAt: string
  maxPlayers: number
  teamSize?: number | null
  joinMode?: Visibility
  skillLevel?: Skill | null
  description?: string
}
export type Game = GameInput & {
  teamSize: number | null
  joinMode: Visibility
  skillLevel: Skill | null
  description: string
  id: string
  organizerId: string
  status: 'scheduled' | 'cancelled' | 'completed'
}
export type GameResult = {
  gameId: string
  teamAScore: number
  teamBScore: number
  status: ResultStatus
  submittedBy: string
  submittedAt: string
  confirmedBy: string | null
  confirmedAt: string | null
  disputeReason: string | null
  revision: number
}
export type Performance = { playerId: string; metrics?: Record<string, number> } & Partial<Record<StatField, number>>
export type ResultInput = Pick<GameResult, 'teamAScore' | 'teamBScore'> & { performances: Performance[] }
export type PlayerGameStat = { gameId: string; playerId: string; team: Team; outcome: Outcome; metrics: Record<string, number> } & Record<StatField, number>
export type PlayerStats = { gamesPlayed: number; wins: number; losses: number; draws: number; metrics: Record<string, number> } & Record<StatField, number>
export type SportStats = PlayerStats & { sport: Sport }
export type RatingSummary = { avgRating: number | null; reviewCount: number }
export type Review = {
  id: string
  gameId: string
  reviewerId: string
  revieweeId: string
  rating: number
  skillRating: number | null
  sport: Sport
  comment: string
  createdAt: string
}
export type PublicReview = Pick<Review, 'id' | 'sport' | 'rating' | 'skillRating' | 'comment'>
export type ReviewInput = Pick<Review, 'revieweeId' | 'rating' | 'comment'> & { skillRating?: number }
export type PlayerDetails = Profile & RatingSummary & {
  stats: PlayerStats
  sportStats: SportStats[]
  reviews: PublicReview[]
}
export type DirectoryPlayer = Profile & RatingSummary & { distanceMiles?: number; stats: PlayerStats; sportStats: SportStats[] }
export type GameSummary = Game & { confirmed: number; result: GameResult | null }
export type GameDetails = GameSummary & {
  roster: (Pick<Profile, 'id' | 'displayName'> & { team: Team | null; skill?: Skill; stats: PlayerStats })[]
  participation: Participation
  joinRequests: (JoinRequest & { playerName: string })[]
  performances: PlayerGameStat[]
  sentInvitations: (Invitation & { recipientName: string })[]
  reviewedPlayerIds: string[]
}
export type Response = 'accepted' | 'declined'
export type Invitation = {
  id: string
  gameId: string
  senderId: string
  recipientId: string
  team: Team | null
  squadId?: string
  status: 'pending' | Response | 'cancelled' | 'expired'
  createdAt: string
  respondedAt: string | null
}
export type InboxItem = Invitation & { game: GameSummary; senderName: string }
export type Session = { userId: string; email: string }
type DirectoryFilters = { sport?: Sport; neighborhood?: Neighborhood; skill?: Skill; gameId?: string; name?: string; replacement?: boolean }
export type PlayerFilters = (DirectoryFilters & { match?: 'exact' }) |
  (DirectoryFilters & { match: 'travel'; sport: Sport; neighborhood: Neighborhood })

export const isUpcoming = (game: Game) =>
  game.status === 'scheduled' && Date.parse(game.startsAt) > Date.now()


export type Participation = {
  isMember: boolean
  canJoin: boolean
  canRequest: boolean
  canClaim: boolean
  ineligibleReason?: string
  requestId?: string
  invitationId?: string
}

export type BrowseGame = GameSummary & Participation & { organizerName: string; distanceMiles: number | null }
export type BrowseFilters = { sport?: Sport; neighborhood?: Neighborhood; from?: string; to?: string; openSpots?: boolean }
export type JoinDecision = 'approved' | 'declined'
export type JoinRequest = {
  id: string; gameId: string; playerId: string; status: 'pending' | JoinDecision | 'cancelled'
  createdAt: string; respondedAt: string | null
}
export type BulkInviteResult = { recipientId: string; invitationId?: string; error?: string }
export type Squad = {
  id: string; name: string; sport: Sport; captainId: string; joinCode: string
  members: Pick<Profile, 'id' | 'displayName'>[]
}
export type NotificationType =
  | 'invitation_received' | 'invitation_accepted' | 'invitation_declined' | 'invitation_cancelled'
  | 'join_request_received' | 'join_request_approved' | 'join_request_declined'
  | 'player_joined' | 'player_withdrew' | 'replacement_needed' | 'replacement_joined'
  | 'new_game_nearby' | 'game_cancelled' | 'results_submitted' | 'results_disputed'
  | 'results_confirmed' | 'level_changed' | 'squad_member_joined'
export type Notification = {
  id: string; type: NotificationType; title: string; body: string; createdAt: string; readAt: string | null
  gameId?: string; invitationId?: string; requestId?: string; squadId?: string
}
export type ChatMessage = {
  id: string; gameId: string; senderId: string; senderName: string; body: string; createdAt: string
}
export type ChatStatus = { lastMessageAt: string | null; lastReadAt: string | null; hasNew: boolean }
