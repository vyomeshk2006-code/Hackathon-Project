# 🏆 Pickup Sports Tampa

### Find Your Team. Get in the Game.

**Pickup Sports Tampa** is a sports matchmaking web application that connects players across Tampa Bay. Whether you're looking for a casual soccer match, organizing a basketball game, or finding teammates for your favorite sport, Pickup Sports Tampa makes it easier to discover games, connect with players, and build a local sports community.

Built as a hackathon project, the platform brings game discovery, player matchmaking, team management, performance tracking, and community engagement into one experience.

**Live Website:** https://pickup-sports-tampa.vercel.app/

---

## 🚀 Features

### 🏟️ Discover & Organize Games
- Browse upcoming and ongoing pickup games across Tampa Bay.
- Create public or invite-only games with customizable schedules, venues, and player limits.
- Search by sport, date, game type, and available spots.
- Get directions to game venues through Google Maps.
- Automatically archive games from discovery after their scheduled end time while preserving match history.

### 👥 Player Profiles & Matchmaking
- Create personalized profiles with unique usernames.
- Add your favorite sports, skill levels, and neighborhood.
- Discover other players based on sports and skill levels.
- Send invitations and manage participation requests.
- Build squads and organize teams.

### ⚽ Game & Team Management
- Manage player rosters and team assignments.
- Approve or decline requests to join invite-only games.
- Invite individual players or entire squads.
- Withdraw from games and coordinate emergency replacements.
- Receive notifications about invitations, approvals, cancellations, and game updates.

### 📊 Match Statistics & Performance
- Record match results and individual player statistics.
- Track wins, losses, draws, and sport-specific performance.
- Confirm or dispute submitted match results.
- Maintain individual match histories and player records.

### ⭐ Dynamic Skill Ratings
Pickup Sports Tampa uses a sport-specific rating model that combines player feedback with actual match performance.

| Sport category | Rating calculation |
|---|---|
| Sports with individual statistics | 50% peer ratings + 30% performance statistics + 20% win rate |
| Sports without individual statistics | 60% peer ratings + 40% win rate |

Players progress through three skill tiers:

- **Beginner:** 0–39
- **Intermediate:** 40–69
- **Advanced:** 70–100

Ratings require sufficient confirmed matches and peer feedback. Statistics-based ratings remain provisional until sport-specific normalization is finalized.

### 🔔 Notifications & Player Connections
- Receive in-app notifications for important game activities.
- Access a game-specific contact directory when authorized.
- Submit anonymous post-match reviews.
- Build a reputation through participation, results, and community feedback.

---

## 💻 Tech Stack

| Category | Technologies |
|---|---|
| Frontend | React, TypeScript |
| Styling | Tailwind CSS, CSS |
| Build Tool | Vite |
| Routing | React Router |
| Backend Integration | Supabase |
| Database | PostgreSQL (planned integration) |
| Authentication | Supabase Auth (planned integration) |
| Deployment | Vercel |
| Version Control | Git & GitHub |

---

## ⚙️ Getting Started

### Prerequisites

- Node.js 22.12 or newer
- npm
- Git

### Installation

**1. Clone the repository**

```bash
git clone https://github.com/vyomeshk2006-code/Hackathon-Project.git
```

**2. Navigate to the frontend**

```bash
cd Hackathon-Project
git checkout Frontend
cd frontend
```

**3. Install dependencies**

```bash
npm ci
```

**4. Start the development server**

```bash
npm run dev
```

Open the local URL displayed in your terminal, typically `http://localhost:5173`.

### Testing & Production Build

```bash
npm test
npm run build
```

---

## 🧪 Demo & Development Status

The current frontend includes a browser-based demonstration environment with sample players, games, and simulated account workflows.

You can explore the application using the available demo accounts and test features such as game creation, player invitations, team management, match results, and reviews.

**Important:** The currently verified frontend uses browser-local demo data. Live Supabase authentication, shared database persistence, and server-enforced privacy rules require completed backend integration and testing. Vercel deployment alone does not enable those features.

---

## 🔮 Future Improvements

- Complete Supabase backend integration and persistent multi-user accounts.
- Implement email verification and secure password recovery.
- Enable real-time synchronization of games, rosters, and notifications.
- Finalize sport-specific performance normalization for automated skill ratings.
- Expand the platform beyond Tampa Bay to additional cities.

---

## 🎯 Our Mission

Finding people to play sports with shouldn't be harder than playing the sport itself.

Pickup Sports Tampa aims to make recreational sports more accessible by connecting players, simplifying game organization, and encouraging active local communities.

**Less organizing. More playing.**

---

**Built with ❤️ in Tampa, Florida.**
