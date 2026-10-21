# Architecture Overview

This document equips agents with a rapid understanding of Job Hunter's architecture, navigation paths, and operational boundaries. Update it as the codebase evolves. It describes the checked-in implementation and deployment configuration, not verified live deployment state.

Job Hunter is a local, single-user application that discovers jobs, assesses remote-location eligibility and technology fit, and lets the user organize saved listings. It is one TypeScript application with separate CLI, web, and worker processes—not a frontend/backend monorepo or a collection of independent application services.

## 1. Project Structure

```text
job-hunter/
├── src/
│   ├── cli.ts                 # Commands, dependency construction, shutdown
│   ├── discovery/
│   │   ├── scheduler.ts       # UTC cron producer for queued discovery
│   │   ├── worker.ts          # Direct discovery operation and queue consumer
│   │   ├── job-url.ts         # ATS listing URL validation and normalization
│   │   └── google.ts          # Query construction, search types, Autom.dev requests
│   ├── review/
│   │   ├── review-jobs.ts     # Enqueue unfinished listings and wait for outcomes
│   │   ├── stages.ts          # Shared processing-stage names and type
│   │   ├── crawl.ts           # Direct extraction/persistence and crawl consumer fan-out
│   │   ├── extraction/
│   │   │   ├── types.ts       # Provider-neutral extraction contract and page errors
│   │   │   ├── ashby.ts       # Board API client, posting selection, text rendering
│   │   │   ├── greenhouse.ts  # Single-job API client, HTML-to-text extraction
│   │   │   ├── lever.ts       # Global/EU posting API client, listing rendering
│   │   │   └── firecrawl.ts   # Scrape API client, Markdown and page-error handling
│   │   ├── location-check.ts  # Direct location assessment/persistence and consumer
│   │   ├── tech-check.ts      # Direct stack assessment/persistence and consumer
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

Feature directories own their workflows and workers. `review/` operations load saved listings, call integrations, and persist results; `review/llm/chatgpt/` owns provider-specific prompts, requests, and response validation without database writes. Ashby, Greenhouse, Lever, and Firecrawl are sibling strategies in `review/extraction/`, selected within `review/crawl.ts`; none uses another. Each provider module co-locates its HTTP client, Valibot response contract, and extraction logic. API functions return structured data; extraction functions call them to select/render a listing and apply page-error policy. Shared request options and page errors live in `review/extraction/types.ts`. Shared queue delivery and storage remain at the source root. File names use `tech-check`, while the existing queue and database stage remains named `stack`.

## 2. High-Level System Diagram

```text
profile.ts + .env
       |
CLI fetch / cron scheduler
       |
BullMQ / Redis: fetch queue
       |
fetch consumer (workers process)
       |--> Autom.dev --> Google results
       v
SQLite: validated, deduplicated listings and stage state
       |
BullMQ / Redis: crawl queue
       |
crawl consumer --> Ashby / Greenhouse / Lever public APIs --> listing text --> SQLite
       |
       +--> location queue --> ChatGPT eligibility --> SQLite
       |
       +--> stack queue ----> ChatGPT technology fit --> SQLite

User <--> Browser UI <--> Local HTTP server <--> SQLite

Firecrawl API <--> Playwright / Redis
```

SQLite is authoritative for job data and processing state. Redis coordinates work and carries listing IDs, not copies of listing text or assessment results. Both assessments consume the same saved listing text and run independently; location rejection does not prevent stack assessment. The browser reads results and changes user review status; it does not run the processing pipeline.

Compose uses two processing containers: `scheduler` only produces discovery tasks, while `workers` runs four separate BullMQ consumers (`fetch`, `crawl`, `location`, and `stack`) in one Node process. Queue names select handlers, not a task discriminator. Each queue has local and global concurrency one; asynchronous work on different queues can overlap. All consumers share startup and shutdown, the profile, SQLite connection, and process-local OAuth refresh coordination. Source remains organized by feature rather than container.

## 3. Core Components

### 3.1. Frontend

**Name:** Local job-review UI.

**Description:** `src/web/index.html` displays saved listings, eligibility and stack assessments, filtering, and active/hidden/rejected review states. Users can change an individual listing's state. Browser state and rendering live in the same document; there is no frontend framework or bundler. `src/web/server.ts` loads the colocated HTML for the HTTP server.

Listings use scan-first cards: role/company/location lead, independent location and stack assessment rows place labels/statuses on the left and summaries/evidence on the right, native `details` elements disclose supporting evidence, and a footer groups the external listing link and review actions. Assessment columns stack on mobile. Component styles use BEM block, element, and modifier classes.

Optimistic status changes apply only while their save requests are pending. Successful saves reload server state rather than retaining local overrides that could hide changes from another tab. Restoring a listing with pending checks shows the explicit `repair` command; status changes do not enqueue processing.

**Technologies:** Plain HTML, CSS, JavaScript, browser Fetch API.

**Deployment:** Served by the application at `http://127.0.0.1:3000`. Build copies the HTML into `dist/web/index.html`; applying UI changes requires rebuilding and restarting the server.

### 3.2. Backend Services

These are execution roles within the same application, sharing source, SQLite, and credentials.

The CLI loads the HTTP server and its HTML asset only for `serve`. Queue loading
uses stage contracts directly and imports SQLite only as a type, so fetch-only
composition does not load the database implementation.

#### 3.2.1. CLI and Discovery Scheduler

**Name:** Command entry point and fetch worker.

**Description:** `src/cli.ts` loads root-relative configuration, constructs dependencies only for commands that need them, dispatches commands, handles sign-in cancellation, and closes shared resources. Commands include `auth`, `fetch`, `scheduler`, `workers`, `review`, `repair`, `retry`, `stack-backfill`, `serve`, and `jobs`. Feature modules own workflow lifecycles: `src/review/review-jobs.ts` owns review enqueueing and outcome waiting, and `src/web/server.ts` owns server startup and graceful shutdown.

`src/discovery/google.ts` builds one combined Google query across Ashby, Lever, and Greenhouse. All title, skill, and search-location terms come from the root profile: array groups are ANDed; canonical names and aliases within a group are ORed. Titles use `intitle:` and skills match page-wide. The builder adds neither a profession nor a remote clause. `searchLocation` controls discovery alternatives; `location` is the candidate's residence for assessment.

`src/discovery/google.ts` calls Autom.dev, paginates, and deduplicates results; fetching requests up to 100 results. The directly callable `discoverJobs` in `src/discovery/worker.ts` validates and canonicalizes URLs through `src/discovery/job-url.ts` before passing accepted results to SQLite. It returns discovered unfinished listing IDs and an outcome (added/pending counts and query failures). The consumer schedules those IDs before logging the outcome and throwing for partial query failures. SQLite persists the supplied URLs and deduplicates by URL; it does not own ATS URL rules. Fetching does not assess jobs.

Valibot validates search response containers and pagination; malformed result entries are skipped and invalid optional snippets/positions are omitted. If a later page fails, completed pages still reach persistence and scheduling alongside a reported query failure. Ashby and Lever UUIDs are normalized to lowercase without changing board-name casing.

Autom error messages are preserved verbatim, with an HTTP-status fallback only for missing or unusable error text. Each search page allows three total attempts: rate-limit `401` responses wait two seconds between attempts, while `500` responses back off for 500 ms then one second. Other statuses are not retried; `404` ends the search as an empty page. Authentication `401` responses are distinguished from rate limits using Autom's error text.

`scheduler` runs `startFetchScheduler` in `src/discovery/scheduler.ts`, passing its `FetchQueue`, with `FETCH_CRON` (default `0 * * * *`, UTC), with no immediate startup enqueue and no overlapping enqueue calls. Shutdown waits for the active enqueue; enqueue failures are logged without stopping future ticks. Scheduler downtime misses ticks; worker downtime leaves queued work waiting. Neither the scheduler nor manual `fetch` loads the profile, database, or search credentials.

`ReviewQueues` manages the three listing-stage queues and their persistence-aware recovery; `FetchQueue` independently manages discovery delivery. Assessment workers receive only their respective review method, with candidate settings attached by the CLI.

`FetchQueue` in `src/bullmq.ts` owns a separate `fetch` queue with prefix `job-hunter`. Cron and manual `fetch` enqueue one complete discovery run with empty payload and BullMQ simple deduplication ID `fetch`, held until completion or failure. Global and local concurrency are one. `src/discovery/worker.ts` exposes `startFetchWorker`, which calls `discoverJobs` and owns downstream delivery and outcome logging. The CLI supplies the shared profile and starts this consumer alongside the review consumers in `workers`. All consumers drain active work before queues and SQLite close. Discovery is not a listing stage and has no `job_stages` row. Each task allows one attempt; partial search failures preserve successful results and mark the run failed without repeating paid searches automatically. Completed tasks are removed and the most recent 20 failures retained; a later trigger can run after either outcome. BullMQ stalled delivery recovery can still repeat external searches after a crash.

**Technologies:** Node.js 22.18+, TypeScript ESM, native Fetch API, node-cron.

**Deployment:** Host CLI or Compose `scheduler` and `workers`, using stock `node:22-bookworm-slim`.

#### 3.2.2. Review Pipeline

**Name:** Independent crawl, location, and stack consumers.

**Description:** `src/review/crawl.ts`, `location-check.ts`, and `tech-check.ts` co-locate directly callable `crawlJob`, `checkLocation`, and `checkTech` operations with their consumer starters. Operations accept a store and listing ID, own active/readiness checks, checkpoint reuse, integration calls, and persistence, and propagate transient errors without marking delivery exhausted. Assessments receive only their LLM method; extraction accepts an optional listing extractor. `src/bullmq.ts` owns worker creation, delivery ID validation, attempts/backoff, failure bookkeeping, and recovery. Workers call the same operations as direct tests. The crawl consumer checks SQLite after the operation and enqueues missing assessments, including redelivery after a completed extraction checkpoint. The CLI starts all three consumers alongside discovery in one `workers` process and closes started consumers on shutdown or partial startup failure. Shutdown drains active tasks rather than cancelling their external calls. Each stage has local and global concurrency one, so different stages can run concurrently but the same stage does not execute in parallel.

Queues use prefix `job-hunter`, names `crawl`, `location`, and `stack`, payload `{ id }`, and stable per-queue IDs `listing-N`. Crawling saves listing text once and schedules both assessments. `src/review/crawl.ts` routes Ashby, Greenhouse, and Lever URLs to their unauthenticated public APIs. The Ashby adapter selects the exact UUID from the board response and saves its plain description with title, primary/secondary locations, address, workplace type, raw remote flag, employment type, department/team, and compensation metadata when provided. It does not interpret `isRemote` as fully remote; workplace type can still be Hybrid. The Greenhouse adapter requests one job with pay transparency enabled, verifies its returned posting ID, and saves all metadata plus its entity-decoded, HTML-to-text description. Lever requests one posting from the global or EU API matching the listing hostname and verifies its UUID. It saves opaque metadata plus the combined plain description, HTML-to-text lists with headings, closing text, and salary description, excluding duplicate HTML and opening/body fields. Processors consult SQLite before work; completed stages cannot overwrite saved results. Redelivered crawl tasks can enqueue missing assessments without extracting again.

Temporary failures receive three attempts with exponential delays of 60 and 120 seconds. Completed tasks are removed; exhausted tasks remain in Redis and become `failed` in SQLite. Permanent listing-page errors terminate crawling, block dependent assessments, and preserve the page error. HTTP 408, 425, 429, and server errors remain retryable, as do service failures and empty extraction. A valid Ashby board response without the UUID is treated as terminal absence (including unlisted jobs); there is no Firecrawl fallback. Ashby API HTTP/network errors, malformed board responses, and empty descriptions remain retryable service/extraction failures.

Explicit retry removes exhausted Redis delivery before resetting its SQLite stage, increments the stage's retry generation, and enqueues a fresh task with the same stable ID. Failure syncing captures that generation before asynchronous Redis reads and updates only the matching generation, so a stale failed-task read cannot undo a retry. An interrupted replacement enqueue leaves pending work recoverable by `repair`.

Greenhouse and Lever API 404/410 responses are terminal and block both assessments. Other HTTP/network errors, malformed responses, mismatched IDs, and empty converted descriptions remain retryable. There is no Firecrawl fallback for either provider. Firecrawl remains available for unmatched hosts, but discovery currently accepts only these three ATS providers.

Recovery commands are explicit:

- `repair [--stage STAGE]`: restore missing pending queue work without resetting exhausted stages.
- `retry --stage STAGE --id N`: reset one failed stage's attempt allowance.
- `stack-backfill`: queue historical missing stack checks for active eligible, unclear, or ineligible listings, preserving location decisions.
- `review [--limit N]`: enqueue unfinished listings and wait for outcomes; requires a separately running worker.

Workers drain active tasks during graceful shutdown. BullMQ recovers stalled delivery after crashes. SQLite and Redis are not a distributed transaction, and a crash after an external response but before its save can repeat that external call.

**Technologies:** BullMQ 6.3.17, redis 6.3.0 via BullMQ's node-redis adapter, Node built-in SQLite, Ashby and Greenhouse public APIs, Firecrawl, ChatGPT, Valibot, entities, html-to-text. The Ashby client validates the jobs array, posting URLs, and string types for title and plain description when present. Valibot loose objects preserve other posting attributes as opaque metadata, including nulls and additional provider fields; nested metadata is not schema-validated. The adapter saves all posting metadata as JSON except the separately appended plain description and excluded HTML description, following the benchmark's send-all approach. The board name comes from an already validated listing URL and is encoded, not revalidated by the client. The adapter owns supported listing identity checks, board/UUID matching, nonblank selected description checks, and terminal absence policy. The Greenhouse client validates the numeric request ID and response ID/content types, preserves opaque metadata, and exposes HTTP failures without applying extraction policy. Its adapter decodes the outer HTML entity layer with entities and converts the HTML with html-to-text, retaining paragraphs, lists, and link destinations. The Firecrawl client validates the success flag and optional Markdown/page-metadata structure; its adapter owns page-error classification and nonblank text checks. Malformed responses fail retryably rather than becoming terminal absence. All extraction adapters share provider-neutral options and page-error classification in `src/review/extraction/types.ts`.

**Deployment:** Compose `workers` or host `workers` command.

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

**Purpose:** Owns canonical URLs, discovery metadata, saved listing text, assessments, user review status, and stage state. `SqliteStore` creates/migrates the schema and saves each result and its stage completion in one transaction. Rediscovery updates `last_seen` without resetting saved decisions.

**Key schemas:**

- `jobs`: listing identity, search metadata, text, location/stack results, and user status.
- `job_stages`: one row per listing/stage, keyed by `(job_id, stage)`, with state, error, and retry generation.

Scheduling queries return only listing IDs and URLs. Summary queries exclude saved listing text at the SQL boundary, stage-readiness checks do not copy descriptions into JavaScript, and unfinished counts are computed in SQLite.

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
| Ashby | Source job listings | Google discovery; unauthenticated GET `https://api.ashbyhq.com/posting-api/job-board/{board}?includeCompensation=true`, exact UUID selection |
| Greenhouse | Source job listings | Google discovery; unauthenticated GET `https://boards-api.greenhouse.io/v1/boards/{board}/jobs/{job_id}?pay_transparency=true` |
| Lever | Source job listings | Google discovery; unauthenticated GET `https://api.lever.co/v0/postings/{site}/{posting_id}` (EU: `api.eu.lever.co`) |
| Self-hosted Firecrawl | Extract listing Markdown | HTTP POST `/v2/scrape`; `FIRECRAWL_URL` defaults to `http://127.0.0.1:3002` |
| OpenAI authentication | ChatGPT subscription sign-in and token refresh | OAuth using the public Codex client and loopback callback on port 1455 |
| ChatGPT subscription backend | Independent location and stack assessments | HTTPS POST to undocumented `backend-api/codex/responses`, SSE streaming, strict JSON-schema output |

`src/review/llm/types.ts` defines the provider contract. `createLlm` currently supports only `MODEL_PROVIDER=chatgpt`; unsupported values fail explicitly. `MODEL_NAME` defaults to `gpt-6-luna` and `MODEL_EFFORT` to `medium`. Assessment functions require saved listing text and validate returned decisions before persistence. Ashby requests retrieve the entire board without caching; Greenhouse and Lever requests retrieve a single posting. All three use a 75-second timeout and caller cancellation. The Lever client validates request UUID/region, response UUID, plain text, and list heading/HTML types while forwarding other metadata unchanged.

## 6. Deployment & Infrastructure

**Cloud provider:** None required; intended for a local machine or self-managed host.

**Key services:** Docker Compose runs `web`, `scheduler`, `workers`, `firecrawl`, `playwright`, and `redis` on a bridge network. Firecrawl starts directly with `node dist/src/index.js` for single-page `/v2/scrape` requests, which run in the API without its NuQ workers, RabbitMQ, or PostgreSQL. Full crawl, batch, and extract workflows are not provisioned. Application services share a read-write checkout bind mount at `/app`, including the database and credentials. There is no application Dockerfile or image build: install dependencies and compile on the host first.

Web, Firecrawl API, and Redis host ports are published on `127.0.0.1` only. Compose uses dependency health checks for relevant worker dependencies, restart policies, bounded JSON-file logs, and shutdown grace periods (two minutes for app services, three for `workers`). The scraper services have resource limits.

App containers use `${UID:-1000}:${GID:-1000}` to keep bind-mounted database and credential writes under the local user's identity. The scheduler and workers services require healthy Redis; workers startup does not depend on Firecrawl health because supported providers use direct APIs. When upgrading from the former service layout, use `docker compose up -d --remove-orphans` to remove the old containers without deleting queue data. The old `fetch-scheduler`, `fetch-worker`, and `review-worker` CLI commands are replaced by `scheduler` and `workers`.

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

**Local setup:** See [README.md](README.md). Use Node.js 22.18+ and pnpm; install with `pnpm install`, configure `.env` from `.env.example`, edit `profile.ts`, and run `pnpm build`. Authenticate with `pnpm job-hunter auth` before model processing. Redis and a running review worker are required for queued assessments; Compose still provisions Firecrawl although supported ATS listings now use direct APIs.

Application configuration/database paths resolve relative to the application directory, not the shell's current directory. Build type-checks the root profile separately, compiles application TypeScript, and copies UI HTML. Node imports the root TypeScript profile at runtime; restart long-running workers after profile changes.

**Testing frameworks:** Node's built-in test runner and assertions. Business tests call application operations directly with in-memory SQLite and real API/model adapters, replacing only external HTTP and credential loading. No Redis, consumer startup, queue polling, or retry timers are used for business cases. Temporary database files are used where persistence across connections matters. The default suite requires neither Redis nor Docker. Separately invoked queue checks run actual consumers against an isolated test Redis service; they cover application-owned dispatch, failure bookkeeping, recovery boundaries, and process lifecycle, not BullMQ's deduplication, reconnection, retry engine, or stalled-task guarantees.

Tests are grouped by the behavior they verify, not every dependency they use:

- `profile.test.mjs`: profile validation and loading; `query.test.mjs`: search-expression rendering; `job-url.test.mjs`: listing URL rules.
- `workflows.test.mjs`: direct discovery URL acceptance/canonicalization, persistence and partial-success outcomes; ATS routing and terminal/transient policy; saved-text handoff through both real model adapters; independent assessments, checkpoint reuse, cancellation, and inactive/missing/readiness guards. Real in-memory SQLite and fixture external HTTP/credentials make outcomes deterministic without queue delivery.
- `workers.queue.mjs`: queued discovery-to-assessment smoke coverage (including dispatch before partial-search failure), exhausted-delivery bookkeeping, targeted retry/repair, stale failure generations, interrupted replacement enqueue, crawl redelivery fan-out, production review waiting/selection/cancellation, CLI startup/draining/cleanup, and scheduler admission. Each case has isolated temporary SQLite storage and a random queue prefix. Fixture delivery allows one attempt to check exhaustion without exercising BullMQ's retry engine. Run explicitly through `pnpm test:queue` with `TEST_REDIS_URL` (default `redis://127.0.0.1:6380`). Compose's optional `redis-test` service uses the `test` profile, ephemeral storage, and loopback port 6380; the suite removes its namespaces, not the service.
- `sqlite.integration.test.mjs`: persistence, transactions, stage-state transitions, and migrations, without running processors.
- `cli.test.mjs`: command routing, arguments, help, and application-relative paths; `web.test.mjs`: HTTP behavior, server lifecycle, and pure UI assessment logic.
- `api-clients.test.mjs`: Ashby, Greenhouse, Lever, and Firecrawl request/response contracts, HTTP failures, timeout and cancellation with mocked network responses. `ashby.test.mjs`, `greenhouse.test.mjs`, `lever.test.mjs`, and `firecrawl.test.mjs`: extraction policy and rendering. `auth.test.mjs`: authentication, real credential storage, and refresh-to-request integration; `chatgpt.test.mjs`: model adapters constructed with fake credential loading and HTTP transport; `llm.test.mjs`: provider selection.
- `google.test.mjs`: search response validation, pagination, and preservation of completed pages after failures.

Real SQLite is appropriate in HTTP and workflow tests; those suites assert their public behavior rather than duplicating database or adapter contracts. CLI execution accepts optional construction dependencies with lazy production defaults; queue tests supply real isolated queue/store instances. `createChatgpt` accepts a credential loader and HTTP transport, allowing both suites to retain real prompt construction and response validation without paid calls or local OAuth secrets. The suites share external fixtures in `test/fixtures/workflow.mjs`, not a fake or synchronous queue driver. No module replacement or experimental test-runner flags are needed.

| Command | Purpose |
| --- | --- |
| `pnpm build` | Profile type-check, TypeScript compilation, UI copy |
| `pnpm check` | Biome lint/format checks, including inline UI code |
| `pnpm test` | Build and run `test/*.test.mjs`; no Redis/Docker required |
| `pnpm test:queue` | Build and run `test/workers.queue.mjs`; isolated test Redis required |

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

**Date of last update:** 2026-10-21.

## 11. Glossary / Acronyms

- **ATS:** Applicant tracking system; the hosted job boards targeted by discovery.
- **Autom.dev:** API provider used to retrieve Google search results.
- **BullMQ:** Redis-backed task queue used for independent processing stages.
- **Crawl:** Extract and persist listing text through Ashby's, Greenhouse's, or Lever's public API; Firecrawl remains for unmatched hosts.
- **Eligibility:** Assessment of whether the candidate can perform the job remotely from their residence.
- **Stack assessment:** Independent comparison of a role's core technologies with configured skill groups.
- **Stage:** One processing unit: `crawl`, `location`, or `stack`.
- **Terminal:** Permanent crawl failure; dependent assessments are blocked.
- **Review status:** User-controlled active/hidden/rejected state, separate from model decisions.
- **Repair:** Restore missing pending queue delivery without granting more attempts to failed stages.
- **Backfill:** Explicitly schedule missing historical stack assessments without resetting location decisions.
- **OAuth:** Delegated authorization used for ChatGPT subscription access.
- **SSE:** Server-sent events; the streaming response format consumed by the ChatGPT integration.
