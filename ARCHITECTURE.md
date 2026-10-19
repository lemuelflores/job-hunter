# Architecture Overview

This document equips agents with a rapid understanding of Job Hunter's architecture, navigation paths, and operational boundaries. Update it as the codebase evolves. It describes the checked-in implementation and deployment configuration, not verified live deployment state.

Job Hunter is a local, single-user application that discovers jobs, assesses remote-location eligibility and technology fit, and lets the user organize saved listings. It is one TypeScript application with separate CLI, web, and worker processes—not a frontend/backend monorepo or a collection of independent application services.

## 1. Project Structure

```text
job-hunter/
├── src/
│   ├── cli.ts                 # Commands, dependency construction, shutdown
│   ├── discovery/
│   │   ├── worker.ts          # UTC scheduled discovery
│   │   ├── discover-jobs.ts   # Search, save listings, enqueue reviews
│   │   └── google.ts          # Query construction, search types, Autom.dev requests
│   ├── review/
│   │   ├── auth.ts            # Provider sign-in and cancellation lifecycle
│   │   ├── worker.ts          # Crawl/location/stack consumers and stage dispatch
│   │   ├── review-jobs.ts     # Enqueue unfinished listings and wait for outcomes
│   │   ├── stages.ts          # Shared processing-stage names and type
│   │   ├── crawl.ts           # Extract and save listing text, enqueue assessments
│   │   ├── location-check.ts  # Run and save location eligibility assessment
│   │   ├── tech-check.ts      # Run and save technology-fit assessment
│   │   ├── firecrawl.ts       # Markdown extraction client and page errors
│   │   └── llm/
│   │       ├── types.ts       # Provider contract and assessment types
│   │       ├── index.ts       # Provider selection
│   │       └── chatgpt/
│   │           ├── auth.ts    # OAuth sign-in, refresh, credential storage
│   │           ├── request.ts # Streaming requests and structured output
│   │           ├── location-check.ts # Location prompt and model response validation
│   │           └── tech-check.ts     # Technology prompt and model response validation
│   ├── web/
│   │   ├── server.ts          # HTTP server, API, validation, HTML loading
│   │   ├── types.ts           # Review-status and API types
│   │   └── index.html         # Entire browser UI: HTML, CSS, JavaScript
│   ├── bullmq.ts              # Shared queue delivery, repair, retry
│   ├── sqlite.ts              # SQLite schema, migrations, domain transitions
│   └── profile.ts             # Profile types, validation, runtime loading
├── test/                      # Node test suites and Redis integration suite
├── profile.ts                 # Candidate search/review preferences
├── .env.example               # Supported environment configuration
├── docker-compose.yml         # App processes and self-hosted Firecrawl stack
├── package.json               # Dependencies, commands, Node requirement
├── pnpm-lock.yaml             # Dependency lockfile
├── tsconfig.json              # Application compilation
├── tsconfig.profile.json      # Root profile type-checking
├── biome.json                 # Formatting and linting
├── .gitignore                 # Excludes secrets, databases, build output
├── README.md                  # Setup and everyday usage
├── ARCHITECTURE.md             # This document
├── dist/                      # Generated JavaScript and copied UI HTML
├── jobs.sqlite                # Local domain database; not versioned
├── .env                       # Local configuration/secrets; not versioned
└── .auth.json                 # Local OAuth credentials; not versioned
```

The tree focuses on application code and operational files. Dependencies, tooling metadata, and local scratch artifacts are omitted.

Feature directories own their workflows and workers. `review/` operations load saved listings, call integrations, and persist results; `review/llm/chatgpt/` owns provider-specific prompts, requests, and response validation without database writes. Shared queue delivery and storage remain at the source root. File names use `tech-check`, while the existing queue and database stage remains named `stack`.

## 2. High-Level System Diagram

```text
profile.ts + .env
       |
CLI fetch / scheduled fetch-worker
       |--> Autom.dev --> Google results
       v
SQLite: validated, deduplicated listings and stage state
       |
BullMQ / Redis: crawl queue
       |
review-worker --> Firecrawl --> listing Markdown --> SQLite
       |
       +--> location queue --> ChatGPT eligibility --> SQLite
       |
       +--> stack queue ----> ChatGPT technology fit --> SQLite

User <--> Browser UI <--> Local HTTP server <--> SQLite

Firecrawl API <--> Playwright / Redis
```

SQLite is authoritative for job data and processing state. Redis coordinates work and carries listing IDs, not copies of listing text or assessment results. Both assessments consume the same saved Markdown and run independently; location rejection does not prevent stack assessment. The browser reads results and changes user review status; it does not run the processing pipeline.

## 3. Core Components

### 3.1. Frontend

**Name:** Local job-review UI.

**Description:** `src/web/index.html` displays saved listings, eligibility and stack assessments, filtering, and active/hidden/rejected review states. Users can change an individual listing's state. Browser state and rendering live in the same document; there is no frontend framework or bundler. `src/web/server.ts` loads the colocated HTML for the HTTP server.

**Technologies:** Plain HTML, CSS, JavaScript, browser Fetch API.

**Deployment:** Served by the application at `http://127.0.0.1:3000`. Build copies the HTML into `dist/web/index.html`; applying UI changes requires rebuilding and restarting the server.

### 3.2. Backend Services

These are execution roles within the same application, sharing source, SQLite, and credentials.

#### 3.2.1. CLI and Discovery Scheduler

**Name:** Command entry point and fetch worker.

**Description:** `src/cli.ts` loads root-relative configuration, constructs dependencies only for commands that need them, dispatches commands, and closes shared resources. Commands include `auth`, `fetch`, `fetch-worker`, `review`, `review-worker`, `repair`, `retry`, `stack-backfill`, `serve`, and `jobs`. Feature modules own workflow lifecycles: `src/review/auth.ts` handles sign-in cancellation, `src/review/review-jobs.ts` owns review enqueueing and outcome waiting, and `src/web/server.ts` owns server startup and graceful shutdown.

`src/discovery/google.ts` builds one combined Google query across Ashby, Lever, and Greenhouse. All title, skill, and search-location terms come from the root profile: array groups are ANDed; canonical names and aliases within a group are ORed. Titles use `intitle:` and skills match page-wide. The builder adds neither a profession nor a remote clause. `searchLocation` controls discovery alternatives; `location` is the candidate's residence for assessment.

`src/discovery/google.ts` calls Autom.dev, paginates, and deduplicates results; fetching requests up to 100 results. `fetchJobs` in `src/discovery/discover-jobs.ts` saves accepted URLs and schedules unfinished jobs found in those results. Fetching does not assess jobs.

`src/discovery/worker.ts` uses `FETCH_CRON` (default `0 * * * *`, UTC), with no immediate startup fetch and no overlapping runs. Shutdown waits for the active fetch; scheduled failures are logged without stopping future runs.

**Technologies:** Node.js 22.18+, TypeScript ESM, native Fetch API, node-cron.

**Deployment:** Host CLI or Compose `fetch-worker`, using stock `node:22-bookworm-slim`.

#### 3.2.2. Review Pipeline

**Name:** Independent crawl, location, and stack consumers.

**Description:** `src/review/worker.ts` constructs consumers and dispatches stages to `crawl.ts`, `location-check.ts`, and `tech-check.ts` in the same directory; `src/bullmq.ts` owns shared queue delivery and recovery. One `review-worker` process hosts three consumers. Each stage has local and global concurrency one, so different stages can run concurrently but the same stage does not execute in parallel.

Queues use prefix `job-hunter`, names `crawl`, `location`, and `stack`, payload `{ id }`, and stable per-queue IDs `listing-N`. Crawling saves Markdown once and schedules both assessments. Processors consult SQLite before work; completed stages cannot overwrite saved results. Redelivered crawl tasks can enqueue missing assessments without scraping again.

Temporary failures receive three attempts with exponential delays of 60 and 120 seconds. Completed tasks are removed; exhausted tasks remain in Redis and become `failed` in SQLite. Permanent listing-page errors terminate crawling, block dependent assessments, and preserve the page error. HTTP 408, 425, 429, and server errors remain retryable, as do service failures and empty extraction.

Recovery commands are explicit:

- `repair [--stage STAGE]`: restore missing pending queue work without resetting exhausted stages.
- `retry --stage STAGE --id N`: reset one failed stage's attempt allowance.
- `stack-backfill`: queue historical missing stack checks for active eligible, unclear, or ineligible listings, preserving location decisions.
- `review [--limit N]`: enqueue unfinished listings and wait for outcomes; requires a separately running worker.

Workers drain active tasks during graceful shutdown. BullMQ recovers stalled delivery after crashes. SQLite and Redis are not a distributed transaction, and a crash after an external response but before its save can repeat that external call.

**Technologies:** BullMQ 6.3.17, redis 6.3.0 via BullMQ's node-redis adapter, Node built-in SQLite, Firecrawl, ChatGPT.

**Deployment:** Compose `review-worker` or host `review-worker` command.

#### 3.2.3. Local HTTP API

**Name:** Review server.

**Description:** `src/web/server.ts` serves the UI and saved data through Node's HTTP server.

| Route | Responsibility |
| --- | --- |
| `GET /` | Serve UI HTML |
| `GET /api/jobs?status=active` | Read active, hidden, or rejected listings |
| `POST /api/jobs/status` | Change one listing's user review status |

Responses are not cached. Request validation and persistence remain server-side; the API has no routes to invoke paid search or model processing.

**Technologies:** Node `node:http`, JSON, `SqliteStore`.

**Deployment:** Host `serve` command or Compose `web`; Compose binds internally to `0.0.0.0` but publishes only loopback port 3000.

## 4. Data Stores

### 4.1. Primary Job Database

**Name:** `jobs.sqlite`.

**Type:** SQLite through Node's built-in `DatabaseSync`.

**Purpose:** Owns canonical URLs, discovery metadata, saved Markdown, assessments, user review status, and stage state. `SqliteStore` creates/migrates the schema and saves each result and its stage completion in one transaction. Rediscovery updates `last_seen` without resetting saved decisions.

**Key schemas:**

- `jobs`: listing identity, search metadata, text, location/stack results, and user status.
- `job_stages`: one row per listing/stage, keyed by `(job_id, stage)`, with state and error.

Separate state dimensions must not be conflated:

| Dimension | Values |
| --- | --- |
| Processing stage | `pending`, `complete`, `failed`, `terminal`, `blocked` |
| Location eligibility | `pending`, `eligible`, `ineligible`, `unclear`, `error` |
| Stack assessment | `not_checked`, `pending`, `match`, `partial_match`, `potential_match`, `unclear`, `error` |
| User review status | `active`, `hidden`, `rejected` |

Legacy job columns remain to preserve historical values and existing database objects; they are not the queue authority.

### 4.2. Queue Storage

**Name:** Shared Redis service.

**Type:** Redis 8.10.2-alpine.

**Purpose:** BullMQ task delivery, attempts, stalled-task recovery, and retained failures; also used by Firecrawl. Compose configures the `redis-data` volume, append-only persistence with `appendfsync everysec`, and `noeviction`. These settings do not replace SQLite or provide exactly-once processing.

### 4.3. Credentials

- `.auth.json`: plaintext OAuth access/refresh credentials, written atomically with restrictive file permissions; automatic refreshes are coalesced within a process.
- `.env`: local service configuration and secrets.

## 5. External Integrations / APIs

| Service | Purpose | Integration method |
| --- | --- | --- |
| Autom.dev | Google search for supported ATS listings | HTTPS GET with `x-api-key` from `AUTOM_API_KEY` |
| Ashby, Lever, Greenhouse | Source job listings | Google discovery and Firecrawl extraction of validated HTTPS URLs |
| Self-hosted Firecrawl | Extract listing Markdown | HTTP POST `/v2/scrape`; `FIRECRAWL_URL` defaults to `http://127.0.0.1:3002` |
| OpenAI authentication | ChatGPT subscription sign-in and token refresh | OAuth using the public Codex client and loopback callback on port 1455 |
| ChatGPT subscription backend | Independent location and stack assessments | HTTPS POST to undocumented `backend-api/codex/responses`, SSE streaming, strict JSON-schema output |

`src/review/llm/types.ts` defines the provider contract. `createLlm` currently supports only `MODEL_PROVIDER=chatgpt`; unsupported values fail explicitly. `MODEL_NAME` defaults to `gpt-6-luna` and `MODEL_EFFORT` to `medium`. Assessment functions require saved listing text and validate returned decisions before persistence.

## 6. Deployment & Infrastructure

**Cloud provider:** None required; intended for a local machine or self-managed host.

**Key services:** Docker Compose runs `web`, `fetch-worker`, `review-worker`, `firecrawl`, `playwright`, and `redis` on a bridge network. Firecrawl starts directly with `node dist/src/index.js` for single-page `/v2/scrape` requests, which run in the API without its NuQ workers, RabbitMQ, or PostgreSQL. Full crawl, batch, and extract workflows are not provisioned. Application services share a read-write checkout bind mount at `/app`, including the database and credentials. There is no application Dockerfile or image build: install dependencies and compile on the host first.

Web, Firecrawl API, and Redis host ports are published on `127.0.0.1` only. Compose uses dependency health checks for relevant worker dependencies, restart policies, bounded JSON-file logs, and shutdown grace periods (two minutes for app services, three for review workers). The scraper services have resource limits.

**CI/CD pipeline:** No checked-in `.github` workflow directory; build, checks, tests, and deployment are invoked manually through package scripts and Compose.

**Monitoring and logging:** Console lifecycle/error output and Docker logs; Compose health checks cover Firecrawl API and Redis. No dedicated metrics, tracing, or alerting stack is configured.

## 7. Security Considerations

**Authentication:** ChatGPT uses OAuth credentials; Autom.dev uses an API key. The local web UI has no login.

**Authorization:** No multi-user roles or permissions. Localhost Host-header checks and same-origin checks on mutations constrain browser access; requests without an Origin header are allowed. These checks are not a substitute for authentication on a public service.

**Data encryption:** External Autom.dev/OpenAI requests use HTTPS. Local HTTP and Redis connections are not configured for TLS; SQLite, `.env`, and OAuth credentials have no application-level encryption at rest. Keep the checkout, backups, and host private.

**Key practices:**

- Listing URLs must match supported HTTPS ATS listing shapes; credentials, custom ports, board homepages, and application-form paths are rejected. Tracking parameters/fragments are stripped and Greenhouse hostnames canonicalized.
- API mutations require JSON, validated fields/statuses, and bodies no larger than 16 KiB. SQL values use bound parameters.
- Browser rendering uses text nodes for listing text. Model prompts mark scraped content as untrusted data, and model decisions are checked against bounded schemas and runtime validation.
- Secrets and databases are ignored by Git. OAuth credentials are saved through atomic replacement with mode `0600`.
- Firecrawl API authentication is disabled in Compose; retain loopback-only exposure. Playwright drops capabilities and enables `no-new-privileges`.
- Root `profile.ts` is executable configuration imported at runtime: treat it as trusted code, not an untrusted profile upload.

## 8. Development & Testing Environment

**Local setup:** See [README.md](README.md). Use Node.js 22.18+ and pnpm; install with `pnpm install`, configure `.env` from `.env.example`, edit `profile.ts`, and run `pnpm build`. Authenticate with `pnpm job-hunter auth` before model processing. Redis, Firecrawl, and a running review worker are required for queued assessments.

Application configuration/database paths resolve relative to the application directory, not the shell's current directory. Build type-checks the root profile separately, compiles application TypeScript, and copies UI HTML. Node imports the root TypeScript profile at runtime; restart long-running workers after profile changes.

**Testing frameworks:** Node's built-in test runner and assertions. Standard suites use mocked external services and temporary databases. The separate queue integration suite uses isolated Docker Redis instances to exercise delivery, retry, connection failure, shutdown, and restart/crash recovery.

| Command | Purpose |
| --- | --- |
| `pnpm build` | Profile type-check, TypeScript compilation, UI copy |
| `pnpm check` | Biome lint/format checks, including inline UI code |
| `pnpm test` | Build and run `test/*.test.mjs` |
| `pnpm test:queue` | Run `test/queue.integration.mjs`; build first, Docker required |

**Code quality tools:** TypeScript and Biome 2.5.15. No frontend build framework is needed. Tests do not require paid search/model calls.

## 9. Future Considerations / Roadmap

No committed feature roadmap is asserted here. Existing architectural limits to preserve or address deliberately:

- The ChatGPT subscription endpoint and public OAuth-client integration are unofficial dependencies that may change upstream.
- SQLite saves and Redis enqueue operations are not atomic together; retain explicit repair and idempotent stage handling. External calls can repeat after crashes.
- OAuth refresh coordination is process-local. Adding more assessment processes requires considering shared credential writes and refresh-token rotation.
- The unauthenticated, shared-filesystem design is for one trusted local user. Remote access or multi-user deployment requires revisiting authentication, transport security, and storage isolation.
- Redis has explicitly configured named-volume persistence in Compose. A broader backup/recovery policy must account separately for SQLite and credentials.

## 10. Project Identification

**Project name:** Job Hunter (`job-hunter`).

**Repository URL:** https://github.com/lemuelflores/job-hunter

**Primary contact/team:** Not declared in the package manifest; use the repository's maintainer/contact channels.

**Date of last update:** 2026-10-19.

## 11. Glossary / Acronyms

- **ATS:** Applicant tracking system; the hosted job boards targeted by discovery.
- **Autom.dev:** API provider used to retrieve Google search results.
- **BullMQ:** Redis-backed task queue used for independent processing stages.
- **Crawl:** Extract and persist listing Markdown through Firecrawl.
- **Eligibility:** Assessment of whether the candidate can perform the job remotely from their residence.
- **Stack assessment:** Independent comparison of a role's core technologies with configured skill groups.
- **Stage:** One processing unit: `crawl`, `location`, or `stack`.
- **Terminal:** Permanent crawl failure; dependent assessments are blocked.
- **Review status:** User-controlled active/hidden/rejected state, separate from model decisions.
- **Repair:** Restore missing pending queue delivery without granting more attempts to failed stages.
- **Backfill:** Explicitly schedule missing historical stack assessments without resetting location decisions.
- **OAuth:** Delegated authorization used for ChatGPT subscription access.
- **SSE:** Server-sent events; the streaming response format consumed by the ChatGPT integration.
