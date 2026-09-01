# H3 Max Realtime Education

Realtime, interruptible science tutoring with continuously generated H3 Max teaching videos.

The tutor listens and speaks naturally while the visual director keeps a bounded queue of five-second clips. The current video never disappears while new media is generating. Interruptions cancel stale work without stopping playback; the first decoded video for the new topic immediately replaces the old one.

## Project demo

https://github.com/user-attachments/assets/48bba979-9c30-438c-871c-73c37431bff3

## Features

- Realtime voice tutoring with automatic barge-in
- Continuous H3 Max video generation from the latest explanation
- Seamless decoded-video handoffs with no blank canvas
- Immediate topic replacement after an interruption
- Transcript, lesson cards, progress state, and reduced-motion support
- Per-learner and global video quotas
- Local in-memory development mode
- Optional PostgreSQL, Redis, and realtime-gateway deployment

## Stack

- Next.js 16, React 19, TypeScript
- fal Grok Voice Realtime and MiniMax H3 Max
- pnpm workspaces and Turborepo
- Vitest
- Optional Neon PostgreSQL, Upstash Redis, and a Node.js realtime gateway

## How H3 prompts are created

The application does not use a separate prompt-writing service. The prompt is derived deterministically from the tutor's current science explanation:

1. Grok Voice produces the spoken science explanation.
2. The realtime transcript is split into concrete scientific subjects as it arrives.
3. Generic greetings are ignored. Each useful subject becomes a five-second visual specification containing the concept, teaching intent, scientific description, and continuity key.
4. `H3PromptCompiler` applies the age-appropriate safety policy, normalizes the subject, and combines it with the permanent illustrated style bible.
5. `/api/fal/generate` sends the compiled prompt directly to `minimax/h3-max/text-to-video`.

Every generated prompt follows this structure:

```text
STYLE BIBLE: premium mixed 2D illustrated motion language, hand-drawn cel
animation, rough ink contours, paper grain, restrained screen-print texture,
and a stable cobalt, crimson, ochre, ivory, and black palette.

Scientific subject: <the current concrete science explanation>

Create a fresh, exactly 5-second, 16:9 scientific animation of only this
subject. Keep the film text-free, centered, and fully illustrated.
```

The tutor supplies the scientific subject through its explanation; application code supplies the visual style, safety checks, duration, aspect ratio, and generation constraints.

## Quick start

Requirements:

- Node.js 22
- pnpm 11.21.0 through Corepack
- A current Chrome or Edge browser
- A fal API key for realtime voice and generated video

```sh
git clone https://github.com/gokayfem/h3-max-education.git
cd h3-max-education
corepack enable
corepack prepare pnpm@11.21.0 --activate
pnpm install --frozen-lockfile
cp .env.example .env
```

Add your fal key to `.env`; nothing else is required for the local demo:

```dotenv
FAL_KEY=your-fal-key
```

Start only the self-contained web demo:

```sh
pnpm dev
```

Open [http://localhost:3000/learn](http://localhost:3000/learn), allow microphone access, and begin a science conversation.

Local development uses in-memory sessions when database and Redis variables are absent. Data resets when the process exits.

## Full workspace

The repository also includes the optional realtime gateway and production persistence adapters:

```text
apps/web                 Next.js application and fal visual director
apps/realtime-gateway    Stateful realtime gateway
packages/domain          Lesson and visual domain logic
packages/protocol        Versioned session and tutor contracts
packages/persistence     In-memory, PostgreSQL, and Redis adapters
packages/science-eval    Tutor evaluation utilities
database/migrations      Forward-only PostgreSQL migrations
deploy                   Vercel and Fly.io deployment configuration
```

To run the complete local infrastructure, configure the database and Redis values in `.env`, start the compatibility services, migrate, then launch the workspace:

```sh
docker compose up -d --wait
.github/scripts/start-local-neon-proxy.sh
REDIS_REST_TLS_DIR=/tmp/h3-max-redis-rest-tls \
  UPSTASH_REDIS_REST_TOKEN=local-development-token \
  .github/scripts/start-redis-rest-tls.sh
export NODE_OPTIONS="--import=file://$PWD/.github/scripts/configure-local-neon.mjs"
export NODE_EXTRA_CA_CERTS=/tmp/h3-max-redis-rest-tls/cert.pem
pnpm exec dotenvx run -f .env -- pnpm --filter @axiom/persistence migrate
pnpm dev:full
```

## Environment

The local web demo requires only `FAL_KEY`. When that key is present:

- Grok Voice and queued H3 Max video generation are enabled automatically.
- The browser-safe feature flags are derived during the Next.js build; the fal key itself remains server-only.
- Typed fallback uses the deterministic local science tutor.
- Sessions, quotas, and lesson state use in-memory storage.

Optional kill switches remain available for debugging: set `FAL_GROK_VOICE_ENABLED=false`, `FAL_QUEUE_ENABLED=false`, or `LOCAL_TUTOR_ENABLED=false`. You do not need to add them otherwise.

A public production deployment intentionally needs durable security infrastructure in addition to `FAL_KEY`:

- `DATABASE_URL`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `TRANSCRIPT_ENCRYPTION_KEY`

The optional standalone realtime gateway additionally requires provider, signing, origin, and Redis configuration. The self-contained local web demo does not use that infrastructure.
Set the optional standalone gateway's `METRICS_AUTH_TOKEN` to a random value of at least 32 characters when Prometheus scraping is required. `/metrics` returns `404` when the token is unset and requires `Authorization: Bearer <token>` when enabled.

Never add a `NEXT_PUBLIC_` prefix to a secret. Configure production values in the hosting provider rather than committing them.

## Commands

```sh
pnpm dev                # self-contained FAL-only web demo
pnpm dev:full           # web, gateway, and all workspace packages
pnpm lint               # ESLint
pnpm typecheck          # TypeScript
pnpm test               # unit and integration tests
pnpm test:coverage      # coverage thresholds
pnpm build              # production builds
pnpm check              # lint, types, tests, and build
```

## Deployment

- Web: Vercel using `deploy/vercel.json`
- Realtime gateway: Fly.io using `deploy/fly.toml`
- Persistence: Neon PostgreSQL and Upstash Redis

Configure deployment secrets in the hosting provider, not in repository files. Apply `database/migrations` before a production release.

## Safety and privacy

H3 Max Realtime Education is an AI learning companion, not an authoritative source, certified curriculum, or medical or safety adviser. Voice audio is sent to configured realtime providers while the microphone is active. Generated visual prompts are sent to fal. Review the included privacy and terms pages before deploying the application to learners.

## Repository policy

- `.env`, `.env.keys`, caches, build output, coverage, and local design artifacts are ignored.
- CI runs lint, type checks, tests, production builds, and credential scanning.
- Do not commit provider keys, database URLs, Redis tokens, generated certificates, or learner data.
