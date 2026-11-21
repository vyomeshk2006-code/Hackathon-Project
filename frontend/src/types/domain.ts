export const sports = {
  soccer: 'Soccer',
  basketball: 'Basketball',
  volleyball: 'Volleyball',
  pickleball: 'Pickleball',
} as const

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

export type Sport = keyof typeof sports
export type Neighborhood = keyof typeof neighborhoods
export type Skill = keyof typeof skills
export type StatField = 'goals' | 'assists' | 'points'
export const sportStatFields: Record<Sport, readonly StatField[]> = {
  soccer: ['goals', 'assists'],
  basketball: ['points', 'assists'],
  volleyball: ['points'],
  pickleball: [],
}
export type Team = 'A' | 'B'
export type TeamAssignment = { playerId: string; team: Team | null }
export type Outcome = 'win' | 'loss' | 'draw'
export type ResultStatus = 'pending' | 'final' | 'disputed'
export type Preference = { sport: Sport; skill: Skill }
export type ProfileInput = {
  displayName: string
  neighborhood: Neighborhood
  travelRadiusMiles: number
  bio: string
  sports: Preference[]
}
export type Profile = ProfileInput & { id: string }
export type GameInput = {
  sport: Sport
  title: string
  venue: string
  neighborhood: Neighborhood
  startsAt: string
  maxPlayers: number
}
export type Game = GameInput & {
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
export type Performance = { playerId: string } & Partial<Record<StatField, number>>
export type ResultInput = Pick<GameResult, 'teamAScore' | 'teamBScore'> & { performances: Performance[] }
export type PlayerGameStat = { gameId: string; playerId: string; team: Team; outcome: Outcome } & Record<StatField, number>
export type PlayerStats = { gamesPlayed: number; wins: number; losses: number; draws: number } & Record<StatField, number>
export type SportStats = PlayerStats & { sport: Sport }
export type RatingSummary = { avgRating: number | null; reviewCount: number }
export type Review = {
  id: string
  gameId: string
  reviewerId: string
  revieweeId: string
  rating: number
  comment: string
  createdAt: string
}
export type ReviewInput = Pick<Review, 'revieweeId' | 'rating' | 'comment'>
export type PlayerDetails = Profile & RatingSummary & {
  stats: PlayerStats
  sportStats: SportStats[]
  reviews: (Review & { reviewerName: string })[]
}
export type DirectoryPlayer = Profile & RatingSummary & { distanceMiles?: number }
export type GameSummary = Game & { confirmed: number; result: GameResult | null }
export type GameDetails = GameSummary & {
  roster: (Pick<Profile, 'id' | 'displayName'> & { team: Team | null })[]
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
  status: 'pending' | Response | 'cancelled' | 'expired'
  createdAt: string
  respondedAt: string | null
}
export type InboxItem = Invitation & { game: GameSummary; senderName: string }
export type Session = { userId: string; email: string }
type DirectoryFilters = { sport?: Sport; neighborhood?: Neighborhood; skill?: Skill; gameId?: string }
export type PlayerFilters = (DirectoryFilters & { match?: 'exact' }) |
  (DirectoryFilters & { match: 'travel'; sport: Sport; neighborhood: Neighborhood })

export const isUpcoming = (game: Game) =>
  game.status === 'scheduled' && Date.parse(game.startsAt) > Date.now()
