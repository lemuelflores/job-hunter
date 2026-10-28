# Job Hunter

Job Hunter finds job listings, assesses them against your CV and preferences,
and presents the results in a local review inbox. AI assessments are advice,
not a substitute for reading the original listing.

## Get started

You'll need Node.js 22.18 or later, pnpm, Docker Compose, and access to a
supported AI account. Configure any discovery credentials you intend to use.

```sh
pnpm install
cp .env.example .env
```

1. Edit `.env` and `discovery.ts` to configure discovery.
2. Create `cv.md` and `candidate-profile.md` in the project root. Both are
   required, private UTF-8 Markdown files and must contain text. The CV should
   describe your experience; the profile should describe your preferences and
   constraints. Search settings are not used as a substitute for either file.
3. Sign in:

   ```sh
   pnpm job-hunter auth
   ```

4. When ready to start scheduled discovery and assessment, run:

   ```sh
   docker compose up -d
   ```

Open <http://localhost:3000>. Scheduled discovery and AI assessments may incur
costs. The worker rereads both candidate files for each assessment, so edits
apply to later work without restarting it. Completed assessments are not
automatically regenerated.

The web container reloads changes from the checkout automatically; no web build
is needed before starting it.

## Review jobs

The inbox shows each listing's recommendation, score, supporting evidence,
and any processing error. Opening the inbox selects the first active listing;
each listing has its own shareable local `/{id}` address. Search and filters
narrow the list.
View opens the original listing; Hide and Reject remove it from the active list.
Use review status in the filter menu to find and restore hidden or rejected listings.
Retry is available for a failed processing stage.

New listings are assessed after their full descriptions are saved. Existing
listings and earlier decisions are preserved on upgrade, but older listings do
not receive a new assessment automatically. To inspect and explicitly queue a
bounded number of eligible older listings:

```sh
pnpm job-hunter backfill --preview --limit 10
pnpm job-hunter backfill --limit 10
pnpm job-hunter backfill --preview --id 42
pnpm job-hunter backfill --id 42
```

The preview does not queue assessments. The second command can lead to paid
model calls when workers are running. It uses saved descriptions and reports
listings without usable saved text or with terminal extraction failures rather
than recrawling them. Repeating it does not overwrite completed results or
automatically retry failed work.
Use `--id` instead of `--limit` to select one specific listing. The listing
must be active, have a usable saved description and completed extraction, and
not already have an assessment or assessment stage. An ineligible ID returns an
error without queueing another listing.

## Commands

```sh
pnpm job-hunter fetch google                  # Queue a discovery run
pnpm job-hunter fetch freehire                 # Queue another discovery source
pnpm job-hunter jobs                           # Print saved active listings
pnpm job-hunter check-url 'https://example.com/job' # Check one saved URL
pnpm job-hunter review --limit 10              # Queue and wait for unfinished work
pnpm job-hunter repair                         # Restore missing deliveries
pnpm job-hunter retry --stage assessment --id 42 # Retry one exhausted stage
docker compose logs -f scheduler workers       # Follow background activity
docker compose down                            # Stop services
```

`check-url` checks one exact saved URL using the same extraction strategy as
the crawler. It hides an active listing only when the source reports HTTP 404
or 410. Other extraction errors leave it unchanged and return a nonzero exit
code. A successful extraction does not guarantee the position is still open.
The command reports status 200 for successful extraction; scheduling and pacing
are the caller's responsibility.

Use `crawl` or `assessment` as the failed stage for `retry`. A failed enqueue
after backfill or retry leaves the selected work pending; `repair` can restore
its delivery. It does not grant exhausted stages new attempts.

## Updating and protecting your data

Stop the scheduler and workers before changing versions. Back up the SQLite
database, including any associated WAL and shared-memory files, and separately
preserve the queue volume and your credentials. Install dependencies before
restarting. Do not run old and new workers together. If
rolling back, stop the new processes and restore a compatible database backup;
do not delete or blindly replay retained queue work.

`jobs.sqlite`, `.auth.json`, `cv.md`, and `candidate-profile.md` are private
local data. Keep them out of version control and backups accessible to others.
Application containers share the project checkout, so each can access files in
it. The web UI is intended for a trusted local user and is exposed on loopback;
it is not a public service or an authentication boundary.

## Development

```sh
pnpm dev                 # Local web development on 127.0.0.1:3001
pnpm typecheck
pnpm check
pnpm test
CHROMIUM_PATH=/path/to/chromium pnpm test:browser
```

The default tests use local fixtures and make no paid requests. See
[ARCHITECTURE.md](ARCHITECTURE.md) for the system map, operational boundaries,
and optional queue tests.
