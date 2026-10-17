# Job Hunter

A personal tool for finding remote jobs and checking whether they hire where you live.

Google search → Firecrawl scraping → ChatGPT eligibility assessment.

Set your roles, skills, and location, then let it run. It finds listings on Ashby, Lever, and Greenhouse, reads the job descriptions, and checks location eligibility so you don't have to open every listing yourself.

![Job Hunter web UI](screenshot.png)

Browse the results in a local web UI. Filter by eligibility, hide jobs you're not interested in, and restore them later. Listings are deduplicated and saved in SQLite.

## Get started

You'll need **Node.js 22.18+**, **pnpm**, **Docker Compose**, an [Autom.dev](https://autom.dev) API key, and a **ChatGPT subscription**.

From your local checkout:

```sh
pnpm install
cp .env.example .env
```

1. In `.env`, set `AUTOM_API_KEY` and choose a private `POSTGRES_PASSWORD`.
2. Edit [`profile.ts`](profile.ts) with your location, job titles, skills, and search locations.
3. Build, sign in with ChatGPT using the URL printed by `auth`, and start everything:

```sh
pnpm build
pnpm job-hunter auth
docker compose up -d
```

Open **<http://localhost:3000>**. Compose runs the web UI, scheduled fetching, background reviews, and Firecrawl together. No systemd or host cron setup needed.

Fetching runs hourly in UTC, starting at the next hour. To get your first results right away:

```sh
pnpm job-hunter fetch
```

The review worker picks up new listings automatically. AI assessments can be wrong—check the original listing before applying.

## Make it yours

[`profile.ts`](profile.ts) is the search profile:

| Field | What to put there |
| --- | --- |
| `location` | Where you live, for hiring eligibility checks |
| `title` | Job titles; use `and(...)` and `or(...)` to combine terms |
| `searchLocation` | Places or work arrangements to search for, like `APAC` or `remote` |
| `skills` | Skills to look for; matching any one is enough |

After editing it, restart the workers:

```sh
docker compose restart fetch-worker review-worker
```

Optional settings in `.env`: `FETCH_CRON` changes the UTC fetch schedule, while `JOB_HUNTER_MODEL` and `JOB_HUNTER_EFFORT` control the reviewer. After changing `.env`, run `docker compose up -d`.

## Usage

```sh
docker compose logs -f fetch-worker review-worker  # Follow activity
docker compose down                              # Stop everything
pnpm job-hunter fetch                            # Search now
pnpm job-hunter jobs                             # List saved jobs
```

After updating the code, run `pnpm install && pnpm build`, then `docker compose restart web fetch-worker review-worker`.

Jobs and login tokens stay in this checkout (`jobs.sqlite` and `.auth.json`). Keep `.auth.json` private—it contains plaintext credentials. Sign in again with `pnpm job-hunter auth` if needed. The web UI is only exposed locally.

## Under the hood

TypeScript, SQLite, and a plain HTML/CSS/JS UI. Autom.dev provides Google results, self-hosted Firecrawl reads the pages, and ChatGPT assesses hiring eligibility. Reviews run one at a time, retry temporary failures, and save each result as it completes.

Searches use Autom credits. ChatGPT access uses an unofficial subscription endpoint, so upstream changes may break it.

For local development:

```sh
pnpm check
pnpm test
```

Tests use mocked services and temporary databases, not live API calls.
