# Job Hunter

A personal tool for finding remote jobs that hire where you live and fit your tech stack.

Google search → Read job descriptions → ChatGPT location and stack checks.

Set your roles, skills, and location, then let it run. It finds listings on Ashby, Lever, and Greenhouse, reads the job descriptions, and checks location and stack fit so you don't have to open every listing yourself.

![Job Hunter web UI](screenshot.png)

Browse the results in a local web UI. Filter by location or stack fit, hide jobs you're not interested in, and restore them later. Listings are deduplicated and saved in SQLite.

## Get started

You'll need **Node.js 22.18+**, **pnpm**, **Docker Compose**, an [Autom.dev](https://autom.dev) API key, and a **ChatGPT subscription**.

From your local checkout:

```sh
pnpm install
cp .env.example .env
```

1. In `.env`, set `AUTOM_API_KEY`.
2. Edit [`profile.ts`](profile.ts) with your location, job titles, skills, and search locations.
3. Build, sign in with ChatGPT using the URL printed by `auth`, and start everything:

```sh
pnpm build
pnpm job-hunter auth
docker compose up -d
```

Open **<http://localhost:3000>**. Everything runs in the background through Docker Compose—no extra scheduling setup needed.

Fetching runs hourly in UTC, starting at the next hour. To get your first results right away:

```sh
pnpm job-hunter fetch
```

Results appear as jobs are found and checked; `fetch` doesn't wait for them. Leave Compose running to keep finding and reviewing jobs. AI assessments can be wrong—check the original listing before applying.

## Make it yours

[`profile.ts`](profile.ts) controls what to search for and how to review it:

| Field | What to put there |
| --- | --- |
| `location` | Where you live, for hiring eligibility checks |
| `title` | Job titles you're looking for; see the example below |
| `searchLocation` | Places or work arrangements to search for, like `APAC` or `remote` |
| `skills` | Technologies to search for and compare against each job; same format as titles |

Each object lists alternatives. Its keys are technology or title names, and its values are other spellings of the same name. Use `[]` when there are no other spellings. Put multiple objects in the array to require a match from each group.

```ts
title: [
  { backend: ['back end', 'back-end'], frontend: ['front end', 'front-end'] },
  { developer: [], engineer: [] },
],
skills: [
  { Laravel: [], Vue: ['Vue.js', 'VueJS'], Nuxt: ['Nuxt.js', 'NuxtJS'] },
],
```

The title example looks for backend or frontend roles called developer or engineer, including the other spellings. Titles search only job titles; skills can appear anywhere on the page.

Each job gets a stack assessment. With Laravel, Vue, and Nuxt configured:

| Assessment | Example |
| --- | --- |
| Match | Laravel backend or Vue frontend |
| Partial match | Laravel + React |
| Potential match | React only |
| Unclear | No stack specified |

The check focuses on technologies used in the role, not bonus skills or passing mentions. Stack assessments don't automatically reject jobs.

After editing it, restart the workers:

```sh
docker compose restart workers
```

Want to tweak things further? In `.env`, `FETCH_CRON` changes the hourly schedule (UTC), while `MODEL_NAME` and `MODEL_EFFORT` control the AI reviewer. After changing `.env`, run `docker compose up -d`.

## Usage

```sh
docker compose logs -f scheduler workers  # See what's happening
docker compose down                       # Stop everything
pnpm job-hunter fetch                      # Search now
pnpm job-hunter jobs                       # List saved jobs in the terminal
```

### Updating

After pulling new code:

```sh
pnpm install
pnpm build
docker compose up -d --remove-orphans --force-recreate web scheduler workers
```

Searches use Autom credits. If a search fails, check the logs and run `fetch` again when you're ready; the next hourly search will also try again.

### Your data

Jobs and login tokens stay in this checkout (`jobs.sqlite` and `.auth.json`). Keep `.auth.json` private—it contains plaintext credentials. Sign in again with `pnpm job-hunter auth` if needed. The web UI is only exposed locally.

Compose keeps queued work in a Docker volume. Avoid `docker compose down -v` unless you want to delete it.

ChatGPT access uses an unofficial subscription endpoint, so upstream changes may break it.

## Development

Working on the code? Start with:

```sh
pnpm check
pnpm test
```

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
