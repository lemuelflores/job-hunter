# Job Hunter

A personal tool for finding remote jobs that hire where you live and fit your tech stack.

Google + Freehire → Job descriptions → ChatGPT location and stack checks.

Set your search settings, residence, and technologies, then let it run. It finds listings and checks location and stack fit so you don't have to open every listing yourself.

![Job Hunter web UI](screenshot.png)

Browse the results in a local web UI. Filter by location or stack fit, hide jobs you're not interested in, and restore them later. Listings are deduplicated and saved in SQLite.

## Get started

You'll need **Node.js 22.18+**, **pnpm**, **Docker Compose**, and a **ChatGPT subscription**. Google discovery also needs an [Autom.dev](https://autom.dev) API key; Freehire needs no account for personal/non-commercial use.

From your local checkout:

```sh
pnpm install
cp .env.example .env
```

1. In `.env`, set `AUTOM_API_KEY` if using Google.
2. Edit [`profile.ts`](profile.ts) with your residence, target technologies, and source-specific search settings.
3. Build, sign in with ChatGPT using the URL printed by `auth`, and start everything:

```sh
pnpm build
pnpm job-hunter auth
docker compose up -d
```

Open **<http://localhost:3000>**. Everything runs in the background through Docker Compose—no extra scheduling setup needed.

Google runs hourly and Freehire every 15 minutes, in UTC, starting at the next scheduled tick. To search right away:

```sh
pnpm job-hunter fetch google
pnpm job-hunter fetch freehire
```

Results appear as jobs are found and checked; these commands don't wait for them. Leave Compose running to keep finding and reviewing jobs. AI assessments can be wrong—check the original listing before applying.

## Make it yours

[`profile.ts`](profile.ts) controls what to search for and how to review it:

| Field | What to put there |
| --- | --- |
| `review.location` | Where you live, such as `Philippines` |
| `review.stack` | A flat list of technology alternatives, such as `['Laravel', 'Vue', 'Nuxt']` |
| `google.enabled` / `freehire.enabled` | Turn each discovery source on or off |
| `google.query` | Shared search terms, without `site:` operators; each ATS is scoped automatically |
| `freehire` | Native [Freehire search settings](https://freehire.me/docs/api), plus `enabled` |

Keep both source objects and set `enabled: false` to disable either. Search settings do not become review requirements automatically.
Each reviewer receives only the candidate data it needs. The location check interprets worldwide and regional hiring scopes against your residence; the stack check recognizes technology aliases. Assessment instructions remain built in—you don't need to write prompts or list geographic aliases.

```ts
review: {
  location: 'Philippines',
  stack: ['Laravel', 'Vue', 'Nuxt'],
},
google: { enabled: true, query: 'intitle:engineer (Laravel OR Vue OR Nuxt) remote' },
freehire: {
  enabled: true,
  work_mode: ['remote'],
  skills: ['laravel', 'vue', 'nuxt'],
  skills_exclude: ['dotnet'],
  posted_within_days: 14,
  sort: 'posted_at',
  limit: 100,
},
```

Freehire accepts its native facets, exclusions, non-geography `_mode` settings, `q`/`q_fields`, semantic search, and numeric/boolean filters. Lists can be arrays or comma-separated strings. Unknown settings and reported ignored filters cause visible errors instead of silently broadening your search.

Google has a **100-result cap per ATS search**. An all-ATS trigger queues one independent search per supported ATS, with overlapping requests and higher Autom credit and rate-limit pressure. Freehire pages through all matching results; `limit` controls page size (1–100), not the total run size. The profile uses `posted_within_days: 14` to filter source posting dates upstream and `sort: 'posted_at'` for newest-posted first. No catalogue-age filter is added automatically. Native `sort`, `order`, and `offset` remain available; omitted sorting defaults to `created_at` descending. Descriptions always use Markdown. Rate limits or Freehire's 10,000-row pagination boundary can interrupt a run; completed pages are saved and the failure is reported.

Freehire skills are OR by default; `skills_mode: 'and'` requires all. Regions and countries also combine as OR, not AND. `reality: ['fresh']` is a separate quality classification, not the posting-date filter.

Both sources queue the original listing for extraction before location and stack checks; Freehire's potentially truncated descriptions are not used for assessments. Existing saved descriptions and assessments remain unchanged.

Each job gets a stack assessment. The stack list contains alternatives, not a requirement to use every technology in one job. With Laravel, Vue, and Nuxt configured:

| Assessment | Example |
| --- | --- |
| Match | Laravel backend or Vue frontend |
| Partial match | Laravel + React |
| Potential match | React only |
| Unclear | No stack specified |

The check focuses on technologies used in the role, not bonus skills or passing mentions. Stack assessments don't automatically reject jobs.

After editing it, restart the scheduler and workers:

```sh
docker compose restart scheduler workers
```

In `.env`, `GOOGLE_CRON` and `FREEHIRE_CRON` change the independent schedules (UTC), while `MODEL_NAME` and `MODEL_EFFORT` control the AI reviewer. After changing `.env`, run `docker compose up -d`.

## Usage

```sh
docker compose logs -f scheduler workers  # See what's happening
docker compose down                       # Stop everything
pnpm job-hunter fetch google               # Queue all supported ATS searches
pnpm job-hunter fetch google --ats smartrecruiters # Select one ATS
pnpm job-hunter fetch freehire             # Queue Freehire search now
pnpm job-hunter jobs                       # List saved jobs in the terminal
```

Google ATS choices: `ashby`, `greenhouse`, `lever`, `workable`,
`smartrecruiters`, `breezyhr`, `bamboohr`, `pinpointhq`, `rippling`, `polymer`,
and `freshteam`. Selecting all runs eleven independent searches (up to 1,100
results), so use `--ats` to limit paid search usage.

### Updating

After pulling new code:

```sh
pnpm install
pnpm build
docker compose up -d --remove-orphans --force-recreate web scheduler workers
```

Google searches use Autom credits. If a search fails, check the logs and run the source-specific command again when ready; its next scheduled run will also try again. Freehire public access is rate-limited and intended for personal/non-commercial use.

When upgrading from combined Google discovery, stop the old scheduler first and let existing discovery work finish with the old workers before rebuilding. Remove the old combined `site:` clause from your Google query, preserving the other terms. Keep the queue volume and retained failures; do not delete or blindly replay paid work. See [ARCHITECTURE.md](ARCHITECTURE.md#discovery-queue-transition) for the read-only queue check.

If enqueueing all ATSs partially fails, the command reports the failed ATSs after attempting every sibling. Some work may already be submitted; deliberately repeating the command deduplicates work while it remains queued or active, but can start another paid search after completion.

### Your data

Jobs and login tokens stay in this checkout (`jobs.sqlite` and `.auth.json`). Keep `.auth.json` private—it contains plaintext credentials. Sign in again with `pnpm job-hunter auth` if needed. The web UI is only exposed locally.

Compose keeps queued work in a Docker volume. Avoid `docker compose down -v` unless you want to delete it.

ChatGPT access uses an unofficial subscription endpoint, so upstream changes may break it.

## Development

Working on the code? Start with:

```sh
pnpm typecheck
pnpm check
pnpm test
```

Backend commands run directly from source; `pnpm build` builds the web UI.
For browser development, run `pnpm job-hunter serve` and `pnpm dev` in separate
terminals, then open <http://127.0.0.1:5173>. The development UI uses the local
server on port 3000 for its API.

Tests make no live API calls and need no Redis or Docker. For how the app works, implementation details, and optional queue integration tests, see [ARCHITECTURE.md](ARCHITECTURE.md).

## More commands

You probably won't need these day to day. Leave Compose running while they finish.

```sh
pnpm job-hunter review --limit 10           # Queue up to 10 unfinished jobs and wait for results
pnpm job-hunter stack-backfill             # Add missing stack checks to older listings
pnpm job-hunter repair                     # Pick up unfinished work that isn't queued
pnpm job-hunter retry --stage stack --id 42 # Give one failed check another try
```

Failed checks show a reason in the UI. For `retry`, use the job's ID and the failed stage: `crawl`, `location`, or `stack`.
