# Job Hunter

Find remote job listings for your roles and skills, then assess hiring eligibility from your location.

Google search → SQLite queue → Firecrawl scraping → ChatGPT eligibility assessment.

The CLI fetches and reviews listings. Cron schedules fetching, a systemd worker reviews new listings automatically, and a local web UI displays saved jobs.

![Job Hunter web UI](screenshot.png)

## Setup

Requires Node.js 22.16+, pnpm, Docker Compose, an [Autom.dev](https://autom.dev) API key, and a ChatGPT plan. No OpenCode or Codex CLI installation is needed.

```sh
pnpm install
cp .env.example .env
# Set AUTOM_API_KEY and a private POSTGRES_PASSWORD in .env.
pnpm build
pnpm job-hunter auth
docker compose up -d
```

Open the URL printed by `auth` to sign in. The browser returns to `http://127.0.0.1:1455/auth/callback`, so port 1455 must be free. Over SSH, forward that port to the machine running Job Hunter first.

Credentials are saved in the Git-ignored `.auth.json` with owner-only permissions. It contains plaintext tokens: never commit or share it. Tokens refresh automatically; run `auth` again if access is revoked or refresh fails.

## Search profile

Edit `profile.jsonc` in the project root before fetching or reviewing.

- `location`: where you live, used to assess remote hiring eligibility.
- `searchLocations`: groups of geographic alternatives, such as Philippines/Manila, APAC/Asia, or worldwide/anywhere. Every search includes one group.
- `roleGroups`: role alternatives, combined across all groups into one OR clause. Searches also require `(developer OR engineer)`, so this tool targets software development roles.
- `skillGroups`: each group generates separate searches. Terms within a group use OR: a Laravel/Vue group matches either skill, not both.

Search count is **3 ATS platforms × skill groups × location groups** (45 with the supplied five skill groups and three location groups). More groups increase search requests and potentially review usage.

Invalid profiles stop processing. Restart the worker after edits; changes affect future searches and pending reviews, not saved assessments. Reviews assess location eligibility, not skill fit.

## Commands

```sh
pnpm job-hunter auth
pnpm job-hunter fetch
pnpm job-hunter review
pnpm job-hunter review --limit 10
pnpm job-hunter worker
pnpm job-hunter serve --port 3000
pnpm job-hunter jobs
```

- `auth` signs in with your ChatGPT subscription.
- `fetch` runs profile-based Autom.dev Google queries across Ashby, Lever, and Greenhouse. It saves and deduplicates individual listing URLs. Partial search failures preserve successful results and exit nonzero.
- `review` processes pending active listings, saving each assessment immediately. `--limit N` caps the number of listings; without it, review processes the pending queue. Request or validation failures stop the command. Restarting skips completed assessments.
- `worker` checks for pending listings every 30 seconds and reviews one at a time.
- `serve` opens the web UI at <http://127.0.0.1:3000>. Filter assessments and hide, reject, or restore listings without deleting them.
- `jobs` prints saved jobs, including retry details.

Configuration, credentials, and `jobs.sqlite` live in the application root, regardless of your working directory. `review` and `worker` cannot run together; they share `.review-lock.sqlite`, which must not be deleted. Ctrl+C stops requests without losing saved assessments.

## Self-hosted Firecrawl

Start self-hosted Firecrawl using the included Compose file. Run these commands from the project root; see the [Firecrawl self-hosting docs](https://docs.firecrawl.dev/contributing/self-host) for more details.

```sh
docker compose up -d              # Start
docker compose ps                 # Check status
docker compose logs --tail 50 api  # View API logs
docker compose down               # Stop and remove containers
```

Start Firecrawl before reviewing jobs. Its unauthenticated API is private at `http://127.0.0.1:3002`; use `FIRECRAWL_URL` to point to another instance. Keep Postgres credentials stable and do not use `down -v` unless you intend to delete stored data.

## Scheduled fetching

Add a cron entry using absolute paths to your Node executable and checkout, for example hourly. Replace `/path/to/node` and `/path/to/job-hunter` before installing:

```cron
0 * * * * /path/to/node /path/to/job-hunter/dist/cli.js fetch >> /path/to/job-hunter/fetch.log 2>&1
```

The application does not install cron entries. Schedule `fetch`, not `review`, when the worker is running.

## systemd review worker

Copy the service template, then replace `/path/to/job-hunter` and `/path/to/node` in the installed copy. Use a stable absolute Node.js 22.16+ path, not an interactive shell version-manager path.

```sh
pnpm build
mkdir -p ~/.config/systemd/user
cp systemd/job-hunter-worker.service ~/.config/systemd/user/
${EDITOR:-vi} ~/.config/systemd/user/job-hunter-worker.service
systemctl --user daemon-reload
systemctl --user enable --now job-hunter-worker.service
journalctl --user -u job-hunter-worker.service -f
```

The service uses `.env` and your saved login; never put tokens in the unit file. To run without an active login, use `loginctl enable-linger "$USER"`. After repeated startup failures, fix the cause, run `systemctl --user reset-failed job-hunter-worker.service`, and restart the service.

## Checks

```sh
pnpm check
pnpm test
```

`check` runs lint and formatting checks. Tests build the application and use temporary databases and mocked services; no live API calls are made.
