# Architecture Overview

This document equips agents with a rapid understanding of Job Hunter's architecture, navigation paths, and operational boundaries. Update it as the codebase evolves. It describes the checked-in implementation and deployment configuration, not verified live deployment state.

Job Hunter is a local, single-user application that discovers jobs, assesses remote-location eligibility and technology fit, and lets the user organize saved listings. It is one TypeScript application with separate CLI, web, and worker processes—not a frontend/backend monorepo or a collection of independent application services.

## 1. Project Structure

```text
job-hunter/
├── src/
│   ├── core/
│   │   ├── listing.ts         # Listings, discovery data, decisions, review statuses
│   │   ├── stages.ts          # Stage names and checkpoint state
│   │   └── profile.ts         # Provider-independent candidate preferences
│   ├── integrations/
│   │   ├── ats/
│   │   │   ├── types.ts       # ATS identity, URL rules, optional API extractor
│   │   │   ├── url.ts         # Common safe listing URL parsing
│   │   │   ├── ashby.ts       # Definition, board API, posting selection/rendering
│   │   │   ├── greenhouse.ts  # Definition, single-job API, HTML-to-text rendering
│   │   │   ├── lever.ts       # Definition, global/EU API, listing rendering
│   │   │   └── workable.ts    # Definition, details/short links, HTML-to-text rendering
│   │   ├── search/
│   │   │   ├── types.ts       # URL-only/full-text discoveries and partial failures
│   │   │   ├── google.ts      # Google config, scoped queries, Autom.dev requests
│   │   │   └── freehire.ts    # Native config, pagination, full text/evidence
│   │   ├── llm/
│   │   │   ├── types.ts       # Provider-neutral inputs, reviewers, auth/errors
│   │   │   └── chatgpt/
│   │   │       ├── index.ts   # Provider construction
│   │   │       ├── auth.ts    # OAuth sign-in, refresh, credential storage
│   │   │       ├── request.ts # Streaming requests and structured output
│   │   │       ├── location-check.ts # Location prompt and response validation
│   │   │       └── tech-check.ts     # Technology prompt and response validation
│   │   ├── extraction.ts     # Shared extraction contract and runtime page errors
│   │   └── firecrawl.ts      # Scrape API, Markdown and page-error handling
│   ├── workflow/
│   │   ├── enqueue.ts         # Narrow enqueue/failure-sync contracts, stage selection
│   │   ├── discover.ts        # Persistence and complete downstream handoff
│   │   ├── crawl.ts           # Capability selection, checkpointing and handoff
│   │   ├── location-check.ts  # Independent location assessment and persistence
│   │   ├── tech-check.ts      # Independent stack assessment and persistence
│   │   └── review-jobs.ts     # Enqueue unfinished listings and wait for outcomes
│   ├── infra/
│   │   ├── sqlite.ts          # Schema, migrations, transactions and transitions
│   │   ├── bullmq.ts          # Delivery, retained-failure sync, repair and retry
│   │   ├── worker-diagnostics.ts # Safe delivery diagnostics
│   │   └── config.ts          # Root paths, environment, executable profile assembly
│   ├── entrypoints/
│   │   ├── compose.ts         # ATS registry and lazy concrete dependency factories
│   │   ├── cli.ts             # Command parsing, lifecycle and shutdown
│   │   ├── scheduler.ts       # Independent UTC cron producers
│   │   └── workers.ts         # Thin adapters for eight queue consumers
│   └── web/
│   │   ├── server.ts          # HTTP server, API, validation, HTML loading
│   │   ├── types.ts           # Web API request types
│   │   └── index.html         # Entire browser UI: HTML, CSS, JavaScript
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

`core/` owns provider-independent domain definitions and imports no outer layer. `integrations/` owns external contracts and implementations without workflow, storage, queue or entrypoint imports. Each ATS co-locates its definition, pure URL rules, HTTP client, Valibot response contract, rendering and extraction policy; Firecrawl is a sibling strategy. Low-level HTTP functions return typed data, not persistence or orchestration. Shared extraction options and runtime page errors live in `integrations/extraction.ts`.

`workflow/` receives search, extraction and reviewer capabilities plus the concrete SQLite store. Discovery and crawl own downstream dispatch through `EnqueueStage`; failure syncing is a separately injected callback bound to infrastructure. Workflows import no concrete provider, BullMQ or entrypoint implementation. `infra/` owns persistence, delivery/recovery and executable configuration assembly. `entrypoints/compose.ts` assembles ATS definitions and concrete dependencies without eager resource construction; CLI, scheduler and workers own delivery/lifecycle wiring. Core candidate preferences are separate from integration-owned source schemas. File names use `tech-check`, while the existing queue and database stage remains named `stack`.

## 2. High-Level System Diagram

```text
profile.ts + .env
       |
CLI fetch google / scheduler (GOOGLE_CRON)
       |
BullMQ / Redis: ashby / greenhouse / lever / workable queues
       |
independent Google ATS consumers (shared workers process)
       |--> Autom.dev API --> Google search results
       v
SQLite: listing URLs and pending crawl
       |
BullMQ / Redis: crawl queue
       |
crawl consumer (workers process)
       |--> Ashby / Greenhouse / Lever / Workable public APIs --> listing text
       v
SQLite: saved text and completed crawl
       |
       +--> shared assessment queues below

profile.ts + .env
       |
CLI fetch freehire / scheduler (FREEHIRE_CRON)
       |
BullMQ / Redis: freehire queue
       |
freehire consumer (workers process)
       |--> Freehire API --> original URLs and full listing text
       v
SQLite: saved text and completed crawl (no extraction needed)
       |
       +--> shared assessment queues below

Shared assessment queues (BullMQ / Redis; consumers in workers process):
       +--> location queue --> ChatGPT eligibility --> SQLite
       +--> stack queue ----> ChatGPT technology fit --> SQLite

User <--> Browser UI <--> Local HTTP server <--> SQLite

Firecrawl API <--> Playwright / Redis
```

SQLite is authoritative for job data and processing state. Redis coordinates work and carries listing IDs, not copies of listing text or assessment results. Both assessments consume the same saved listing text and run independently; location rejection does not prevent stack assessment. The browser reads results and changes user review status; it does not run the processing pipeline.

Both discovery sources use the same scheduler process with independent cron schedules and separate queue consumers. Both validate and deduplicate listings before persistence. Google supplies listing URLs that need extraction; Freehire supplies full text and completes the crawl checkpoint during ingestion. Both then feed the same location and stack assessment queues.

Compose uses two processing containers: `scheduler` only produces discovery tasks, while `workers` runs up to eight separate BullMQ consumers (`ashby`, `greenhouse`, `lever`, `workable`, `freehire`, `crawl`, `location`, and `stack`) in one Node process. Each source object's `enabled` flag controls its schedulers and consumers; manual commands reject disabled sources. Both configuration objects remain required. Queue names select handlers, not a task discriminator. Each queue has local and global concurrency one; asynchronous work on different queues can overlap. All consumers share startup and shutdown, the profile, SQLite connection, and process-local OAuth refresh coordination. Source remains organized by feature rather than container.

## 3. Core Components

### 3.1. Frontend

**Name:** Local job-review UI.

**Description:** `src/web/index.html` displays saved listings, eligibility and stack assessments, filtering, and active/hidden/rejected review states. Users can change an individual listing's state. One Alpine.js component and keyed templates own browser state and rendering in the same document, without a bundler. Listing/model text uses `x-text`, never HTML interpretation; external links accept only HTTP(S). `src/web/server.ts` loads the colocated HTML and locally built Alpine asset for the HTTP server.

Listings use scan-first cards: role/company/location lead, with the discovery source (Google or Freehire) alongside company and location. Independent location and stack assessment rows place labels/statuses on the left and summaries/evidence on the right, native `details` elements disclose supporting evidence, and a footer groups the external listing link and review actions. Assessment columns stack on mobile. Component styles use BEM block, element, and modifier classes.

Optimistic status changes apply only while their save requests are pending. Successful saves reload server state rather than retaining local overrides that could hide changes from another tab. Restoring a listing with pending checks shows the explicit `repair` command; status changes do not enqueue processing.

The URL owns validated `status`, `eligibility`, and `stack` selections, including browser back/forward navigation. Reading position is not stored; full reload scrolling is left to the browser. In-page reconciliation anchors the first visible surviving card (then later/earlier cards as fallback) and keeps keyed card/assessment DOM, preserving evidence disclosures. If a focused card disappears, focus moves to the next surviving card heading, then the previous heading, then the selected status button, without scrolling for focus.

The component polls the selected status every five seconds while visible and on visibility return, admits at most one current listing read, and retains cached results on refresh errors with an explicit retry control. Status changes and successful saves invalidate older reads; pending moves overlay server data until the save resolves. Save failures restore source membership, while successful saves clear the overlay and fetch authoritative state. A failed follow-up read does not roll back a successful save.

**Technologies:** HTML, CSS, JavaScript, Alpine.js 3.17.5, browser Fetch API.

**Deployment:** Served by the application at `http://127.0.0.1:3000`. Build copies the HTML into `dist/web/index.html` and the pinned Alpine package's prebuilt browser script into `dist/web/alpine.js`. An explicit `GET /alpine.js` route serves it locally behind the same Host checks; no CDN, bundler, or general static-file serving is used. Applying UI changes requires rebuilding and restarting the server.

### 3.2. Backend Services

These are execution roles within the same application, sharing source, SQLite, and credentials.

The CLI loads the HTTP server and its HTML asset only for `serve`. Queue loading
uses stage contracts directly and imports SQLite only as a type, so enqueue-only
composition does not load the database implementation.

#### 3.2.1. CLI and Discovery Scheduler

**Name:** Command entry point and independent discovery workers.

**Description:** `src/entrypoints/cli.ts` loads root-relative configuration, requests lazy dependencies from `src/entrypoints/compose.ts`, dispatches commands, handles sign-in cancellation, and closes shared resources. Commands include `auth`, `fetch google`, `fetch freehire`, `scheduler`, `workers`, `review`, `repair`, `retry`, `stack-backfill`, `serve`, and `jobs`. Bare `fetch` prints help, not a combined run. `src/workflow/review-jobs.ts` owns review enqueueing and outcome waiting, and `src/web/server.ts` owns server startup and graceful shutdown.

The profile contains `review` (`location` residence string, flat `stack` string array), `google` (`enabled`, shared base `query`), and `freehire` (`enabled` plus native search parameters). `src/infra/config.ts` assembles core candidate validation and integration-owned source schemas. Composed Valibot schemas reject unknown fields outside Freehire, blank locations, empty/nested/blank stack entries, enabled blank Google queries, `site:` operators in the base query, and removed profile formats, reporting the invalid field path. The Freehire schema lives in `src/integrations/search/freehire.ts` and is reused by the profile schema and standalone client validation; it checks enablement, serializable parameter types, pagination bounds, and Markdown output, leaving filter semantics to the API. `src/integrations/search/google.ts` collapses whitespace, groups the complete base expression and appends the selected ATS's application-owned host group. It never strips arbitrary user syntax, generates aliases, or translates review settings. The root query preserves the user's existing titles, aliases, skills and geography. Assessment prompts, output contracts, decision definitions and untrusted-listing safeguards are application-owned. The location model receives only the residence and interprets worldwide/global/anywhere and region membership such as APAC/SEA, retaining explicit hiring exclusions. The stack model receives only the flat technology alternatives and interprets aliases without requiring every target in one job. The profile contains candidate data, not prompts or geographic alias lists.

`src/integrations/search/google.ts` calls Autom.dev, paginates, and deduplicates results up to 100 per ATS run. Each ATS definition owns its selector, hosts, pure URL normalization and optional API extractor. `ATS_DEFINITIONS` in `src/entrypoints/compose.ts` is the single assembled registry; the selector union, CLI choices, queue construction and scheduler/worker fan-out derive from it. Greenhouse keeps both board hosts together; Lever keeps global/EU hosts together. The Google adapter uses the selected definition to reject sibling URLs and prepares URL-only discoveries with the executed query and `source=google`. `discoverGoogleJobs(store, search, enqueue, syncFailures)` in `src/workflow/discover.ts` persists them, reconciles retained failures and dispatches missing stages before returning counts or throwing `DiscoveryPartialFailure` with the saved outcome. SQLite deduplicates supplied URLs but does not own URL rules. Adding an ATS means defining URL rules and an optional extractor, registering the definition and adding tests—not new CLI branches or copied workflows.

`discoverFreehireJobs` receives a search capability composed from `src/integrations/search/freehire.ts`, calling `GET https://freehire.me/api/v1/agent/jobs/search?description_format=markdown`. The client validates response pagination and interpreted URL/title/description fields, skips malformed or blank entries, and refuses pages reporting ignored parameters or values. It preserves earlier successful pages on later HTTP, validation, timeout or cancellation failures. Native search parameters pass through as strings, string arrays, numbers or booleans; arrays serialize as comma-separated values. Filter names, vocabularies and combinations are validated by Freehire rather than mirrored locally. API-reported ignored settings fail the run visibly instead of accepting a broadened search. `integrations/search/types.ts` explicitly separates URL-only discoveries with optional snippets from full-text discoveries with required listing text; source adapters own metadata rendering, publication dates and provenance/query snapshots, while workflows own persistence and dispatch.

Freehire pages through all matching results with no application per-run cap; the 100-result cap applies only to each Google ATS run. Pages contain `limit` rows (default/max 100), with optional native `offset` and client defaults `sort=created_at&order=desc`. The root profile sets `posted_within_days=14` and `sort=posted_at`, filtering source posting dates upstream rather than catalogue creation age. No date filter or age ceiling is added by the client; native date settings pass through to Freehire. Markdown is fixed for the assessment pipeline. Empty pages or the reported total stop the scan; logs report scanned/total. Reaching the upstream 10,000-row pagination boundary with results remaining fails visibly and preserves completed pages. There is no persistent cursor, and offset shifts can miss listings. API warnings and rate-budget exhaustion fail the run visibly; requests identify this project and stop requesting more pages when the remaining rate budget is zero. Public access is rate-limited and licensed for personal/non-commercial use.

Freehire URLs reuse ATS canonicalization for recognized listing identities through an injected normalizer; otherwise the original HTTP(S) URL is preserved rather than guessing identity from `source`. Malformed URLs, non-HTTP(S) schemes and embedded credentials are rejected. There is no additional hostname, IP-address, port or ATS-path filter for Freehire links because ingestion does not fetch them; Google's strict ATS validation is unchanged. The job title and full description are persisted, with insertion and pending-crawl completion in one SQLite transaction. Saved listing text prefixes the description with Freehire's title, company, location, countries, regions, and work mode when supplied; these fields are accepted as evidence for the existing reviewers without an ATS request. Optional metadata is type-validated and may be missing or null. Only active jobs with no text and pending crawl can receive incoming text. Rediscovery never overwrites saved text, decisions, status, failed/terminal/blocked stages or retry generations. Failed crawls require explicit retry; terminal crawls remain terminal. The Freehire workflow invokes its injected retained-failure sync before ingestion, then queues missing assessments without an extraction task. A save/dispatch gap remains repairable with `repair`.

Valibot validates search response containers and pagination; malformed result entries are skipped and invalid optional snippets/positions are omitted. If a later page fails, completed pages still reach persistence and scheduling alongside a reported query failure. Ashby and Lever UUIDs are normalized to lowercase without changing board-name casing.

Autom error messages are preserved verbatim, with an HTTP-status fallback only for missing or unusable error text. Each search page allows three total attempts: rate-limit `401` responses wait two seconds between attempts, while `500` responses back off for 500 ms then one second. Other statuses are not retried; `404` ends the search as an empty page. Authentication `401` responses are distinguished from rate limits using Autom's error text.

`scheduler` runs `startDiscoveryScheduler` in `src/entrypoints/scheduler.ts`, passing enabled queues. `GOOGLE_CRON` defaults to `0 * * * *`, and `FREEHIRE_CRON` to `*/15 * * * *`, both UTC. Up to five cron tasks admit work independently, with no startup enqueue and no overlapping calls per queue. Shutdown destroys all tasks and waits for active enqueues; enqueue failures are logged without stopping future ticks. Scheduler downtime misses ticks; worker downtime leaves queued work waiting. Scheduler and manual source commands load the profile for enablement, but not SQLite, model credentials or search credentials.

`ReviewQueues` manages the three listing-stage queues and persistence-aware recovery; one `DiscoveryQueue` instance per Google ATS plus Freehire independently manages discovery delivery. Assessment workers receive only their respective review method, with `review.location` or `review.stack` bound by the CLI.

`DiscoveryQueue` in `src/infra/bullmq.ts` owns queues `ashby`, `greenhouse`, `lever`, `workable`, and `freehire` under prefix `job-hunter`. Discovery worker names match their queue names. Cron and manual commands enqueue empty payloads with simple deduplication IDs matching each queue, held until completion/failure. Global/local concurrency are one per queue. `startGoogleWorker` and `startFreehireWorker` in `src/entrypoints/workers.ts` bind composed capabilities and queue callbacks to their workflows; they contain no downstream dispatch loops. BullMQ owns delivery diagnostics. CLI starts enabled consumers alongside review consumers. All drain active work before queues and SQLite close. Discovery is not a listing stage and has no `job_stages` row. Each run allows one attempt; successful pages are persisted/dispatched before reporting partial failure, without automatically repeating an entire paid search. Completed deliveries are removed and the latest 20 failures retained per queue. A later trigger can run after either outcome; stalled delivery recovery can repeat external searches after crashes. Google diagnostics retain `source=google` and add `worker` and `ats` identities.

`fetch google --ats ashby|greenhouse|lever|workable` enqueues one ATS; omitted `--ats` enqueues all supported ATSs. Invalid/missing selectors and selectors on other sources fail before delivery. All-ATS manual fan-out attempts every sibling and reports individual failures; delivery is not atomic. Each ATS gets the shared `GOOGLE_CRON` schedule in an independent no-overlap task, so a slow/failing enqueue cannot suppress siblings. Freehire retains its independent schedule. An all-ATS trigger can retrieve up to 400 results with overlapping paid requests; repeating after completion can incur another search.

#### Discovery queue transition

Installations using the former `worker-ashby`, `worker-greenhouse`, and
`worker-lever` queue names must stop scheduling and drain those queues with the
old workers before switching to `ashby`, `greenhouse`, and `lever`. Use the
read-only check below for each old queue name, preserve retained failures, and
do not delete or replay paid work to rename queues. Freehire is unchanged.

The former combined `google` queue is not consumed by per-ATS workers. Before rebuilding a running installation, stop its old scheduler (`docker compose stop scheduler`), keep the old workers available, and verify that `wait`, `active`, `delayed`, `paused`, and `prioritized` are empty with this read-only check using the old installation/dependencies. These historical checks intentionally import the old `dist/bullmq.js`; on a layered build, use `dist/infra/bullmq.js` instead. Importing this module registers the node-redis adapter; do not omit it or rebuild an old installation before draining:

```sh
node --input-type=module -e 'import "./dist/bullmq.js"; import { Queue } from "bullmq"; const q = new Queue("google", { prefix: "job-hunter", connection: { url: process.env.REDIS_URL || "redis://127.0.0.1:6379", enableOfflineQueue: false } }); try { console.log(await q.getJobCounts("wait", "active", "delayed", "paused", "prioritized", "failed")); } finally { await q.close(); }'
```

Drain deliverable work and deliberately resolve failed paid searches with the old workers before switching; preserve retained failures. Stop old workers, remove only the combined `site:` clause from `google.query`, rebuild, and recreate scheduler/workers. Do not delete queues or blindly replay paid work. There is no SQLite migration and no Compose service change. Review-stage and Freehire queues are unchanged.

For older installations that still use the single-source `fetch` queue, the preceding transition must also account for that queue:

The old Redis `fetch` queue is not consumed by the new version. Before rebuilding a running installation, stop its old scheduler (`docker compose stop scheduler`), leave old workers running, and verify `wait`, `active`, `delayed`, `paused`, and `prioritized` are empty. With the old installation/dependencies, this read-only check prints the counts:

```sh
node --input-type=module -e 'import "./dist/bullmq.js"; import { Queue } from "bullmq"; const q = new Queue("fetch", { prefix: "job-hunter", connection: { url: process.env.REDIS_URL || "redis://127.0.0.1:6379", enableOfflineQueue: false } }); try { console.log(await q.getJobCounts("wait", "active", "delayed", "paused", "prioritized", "failed")); } finally { await q.close(); }'
```

Resolve any unfinished failed discovery run deliberately while the old worker is available; do not delete its queue. Once no deliverable work remains, stop old workers, rebuild, update the profile/environment and recreate scheduler/workers. An empty queue needs no data migration. Retained failure records may remain for inspection; no automatic queue deletion or legacy consumer is provided. Review-stage queues and SQLite data are unchanged.

**Technologies:** Node.js 22.18+, TypeScript ESM, native Fetch API, node-cron.

**Deployment:** Host CLI or Compose `scheduler` and `workers`, using stock `node:22-bookworm-slim`.

#### 3.2.2. Review Pipeline

**Name:** Independent crawl, location, and stack consumers.

**Description:** `src/workflow/crawl.ts`, `location-check.ts`, and `tech-check.ts` own directly callable `crawlJob`, `checkLocation`, and `checkTech` operations. Their consumer starters live together in `src/entrypoints/workers.ts`. Operations accept a store and listing ID, own active/readiness checks, checkpoint reuse, integration calls, and persistence, and propagate transient errors without marking delivery exhausted. Assessments receive only their reviewer callback. Crawl receives ATS definitions, a fallback extractor and a required enqueue callback; it selects the API strategy by hostname or uses Firecrawl when no API strategy exists. API errors never trigger scraping fallback. `src/infra/bullmq.ts` owns worker creation, delivery ID validation, attempts/backoff, failure bookkeeping, and recovery. Workers call the same operations as direct tests. The crawl workflow itself enqueues missing assessments, including after checkpoint reuse or concurrent Freehire completion. Enqueue failures propagate without undoing a saved checkpoint. The CLI starts all three consumers alongside discovery in one `workers` process and closes started consumers on shutdown or partial startup failure. Shutdown drains active tasks rather than cancelling their external calls. Each stage has local and global concurrency one, so different stages can run concurrently but the same stage does not execute in parallel.

Queues use prefix `job-hunter`, names `crawl`, `location`, and `stack`, payload `{ id }`, and stable per-queue IDs `listing-N`. Crawling saves listing text once and schedules both assessments. `src/workflow/crawl.ts` selects Ashby, Greenhouse, Lever, and Workable API extractors from injected definitions. The Ashby adapter selects the exact UUID from the board response and returns its plain description with title, primary/secondary locations, address, workplace type, raw remote flag, employment type, department/team, and compensation metadata when provided. It does not interpret `isRemote` as fully remote; workplace type can still be Hybrid. The Greenhouse adapter requests one job with pay transparency enabled, verifies its returned posting ID, and returns all metadata plus its entity-decoded, HTML-to-text description. Lever requests one posting from the global or EU API matching the listing hostname and verifies its UUID. It returns opaque metadata plus the combined plain description, HTML-to-text lists with headings, closing text, and salary description, excluding duplicate HTML and opening/body fields. The workflow persists extraction results. Processors consult SQLite before work; completed stages cannot overwrite saved results. Redelivered crawl tasks can enqueue missing assessments without extracting again.

Temporary failures receive three attempts with exponential delays of 60 and 120 seconds. Completed tasks are removed; exhausted tasks remain in Redis and become `failed` in SQLite. Permanent listing-page errors terminate crawling, block dependent assessments, and preserve the page error. HTTP 408, 425, 429, and server errors remain retryable, as do service failures and empty extraction. A valid Ashby board response without the UUID is treated as terminal absence (including unlisted jobs); there is no Firecrawl fallback. Ashby API HTTP/network errors, malformed board responses, and empty descriptions remain retryable service/extraction failures.

Explicit retry removes exhausted Redis delivery before resetting its SQLite stage, increments the stage's retry generation, and enqueues a fresh task with the same stable ID. Failure syncing captures that generation before asynchronous Redis reads and updates only the matching generation, so a stale failed-task read cannot undo a retry. An interrupted replacement enqueue leaves pending work recoverable by `repair`.

Greenhouse, Lever, and Workable API 404/410 responses are terminal and block both assessments. Other HTTP/network errors, malformed responses, mismatched IDs, and empty converted descriptions remain retryable. There is no Firecrawl fallback for these providers. Firecrawl remains available for unmatched hosts, but discovery currently accepts only these four ATS providers.

Workable is a sibling extraction strategy in `integrations/ats/workable.ts`, selected by `crawlJob` from the composed definitions. The `workable` discovery queue/consumer uses the shared base query scoped to `site:apply.workable.com`, alongside the other ATS queues. There are five independent discovery cron tasks including Freehire. Workable accepts `/account/j/SHORTCODE` and `/j/SHORTCODE` listing URLs, strips tracking/trailing slashes, and uppercases ten-character hexadecimal shortcodes. Short links resolve through one manual redirect, validated to the same shortcode on the HTTPS Workable host before requesting details. Short and account-scoped URLs remain distinct database identities. Its public job-detail API validates the shortcode and HTML description/requirements/benefits, preserving other metadata opaquely. Extraction verifies the shortcode, converts all three HTML sections to text, and returns `published` as the posting date, never `created_at`. Requests use a 75-second timeout and caller cancellation; missing/gone short links follow the same terminal policy.

Recovery commands are explicit:

- `repair [--stage STAGE]`: restore missing pending queue work without resetting exhausted stages.
- `retry --stage STAGE --id N`: reset one failed stage's attempt allowance.
- `stack-backfill`: queue historical missing stack checks for active eligible, unclear, or ineligible listings, preserving location decisions.
- `review [--limit N]`: enqueue unfinished listings and wait for outcomes; requires a separately running worker.

Workers drain active tasks during graceful shutdown. BullMQ recovers stalled delivery after crashes. SQLite and Redis are not a distributed transaction, and a crash after an external response but before its save can repeat that external call.

**Technologies:** BullMQ 6.3.17, redis 6.3.0 via BullMQ's node-redis adapter, Node built-in SQLite, Ashby and Greenhouse public APIs, Firecrawl, ChatGPT, Valibot, entities, html-to-text. The Ashby client validates the jobs array, posting URLs, and string types for title and plain description when present. Valibot loose objects preserve other posting attributes as opaque metadata, including nulls and additional provider fields; nested metadata is not schema-validated. The adapter renders all posting metadata as JSON except the separately appended plain description and excluded HTML description. The board name comes from an already validated listing URL and is encoded, not revalidated by the client. The adapter owns supported listing identity checks, board/UUID matching, nonblank selected description checks, and terminal absence policy. The Greenhouse client validates the numeric request ID and response ID/content types, preserves opaque metadata, and exposes HTTP failures without applying extraction policy. Its adapter decodes the outer HTML entity layer with entities and converts the HTML with html-to-text, retaining paragraphs, lists, and link destinations. The Firecrawl client validates the success flag and optional Markdown/page-metadata structure; its adapter owns page-error classification and nonblank text checks. Malformed responses fail retryably rather than becoming terminal absence. All extraction adapters share provider-neutral options and page-error classification in `src/integrations/extraction.ts`.

**Deployment:** Compose `workers` or host `workers` command.

#### 3.2.3. Local HTTP API

**Name:** Review server.

**Description:** `src/web/server.ts` serves the UI and saved data through Node's HTTP server.

| Route | Responsibility |
| --- | --- |
| `GET /` | Serve UI HTML |
| `GET /alpine.js` | Serve the pinned local Alpine browser script |
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

`jobs.first_seen` records immutable first discovery. `jobs.posted_at` stores Freehire's `posted_at`, Ashby's `publishedAt`, Greenhouse's `first_published`, or Workable's `published`; update timestamps and catalogue creation dates are never substituted. Extraction returns text and optional posting date together, saved with the crawl checkpoint. Rediscovery can fill an unknown posting date but preserves an existing one and the first-seen date. The column migration recovers valid publication dates from existing provider metadata snapshots without re-fetching listings or resetting processing; absent or invalid dates remain unknown.

**Key schemas:**

- `jobs`: listing identity, search metadata, text, location/stack results, and user status. `source` records the first discovery provider (`google` or `freehire`); `query` retains the Google query text or a JSON snapshot of the configured Freehire settings at search start (implicit client defaults are not expanded). Rediscovery preserves both fields, including across sources. Migration labels historical `query='freehire'` rows as Freehire and other rows as Google; historical Freehire configurations cannot be recovered, so those queries retain the old marker.
- `job_stages`: one row per listing/stage, keyed by `(job_id, stage)`, with state, error, and retry generation.

Scheduling queries return only listing IDs and URLs. Summary queries exclude saved listing text at the SQL boundary, stage-readiness checks do not copy descriptions into JavaScript, and unfinished counts are computed in SQLite.

Separate state dimensions must not be conflated:

Persisted review-status values and their type are owned by `core/listing.ts`, beside
`Listing`; the web request contract consumes that type and the HTTP server uses
the same values for validation. SQL constraints retain the same accepted values.

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

Assessment inputs require saved listing text plus the candidate residence for
location checks or flat technology array for stack checks; adapters never load the
root profile. `SavedListingInput` and named
reviewer callbacks let CLI-bound workers receive text and per-operation model,
effort, and cancellation options without requiring candidate settings again.
`createChatgpt` constructs both reviewers with one HTTP transport, credential
loader, and optional credential path; these are not per-assessment overrides.
OAuth credential operations retain their own low-level options for token exchange
and storage, while the provider's authentication contract exposes only cancellation
and authorization notification.

The CLI renders browser sign-in instructions through `onAuthorize`. OAuth owns
the callback listener and token exchange, reports the URL through that callback,
and does not print browser instructions itself.

| Service | Purpose | Integration method |
| --- | --- | --- |
| Autom.dev | Google search for supported ATS listings | HTTPS GET with `x-api-key` from `AUTOM_API_KEY` |
| Freehire | Full descriptions and original URLs | Unauthenticated HTTPS GET `/api/v1/agent/jobs/search`, native filters, `description_format=markdown` |
| Ashby | Source job listings | Google discovery; unauthenticated GET `https://api.ashbyhq.com/posting-api/job-board/{board}?includeCompensation=true`, exact UUID selection |
| Greenhouse | Source job listings | Google discovery; unauthenticated GET `https://boards-api.greenhouse.io/v1/boards/{board}/jobs/{job_id}?pay_transparency=true` |
| Lever | Source job listings | Google discovery; unauthenticated GET `https://api.lever.co/v0/postings/{site}/{posting_id}` (EU: `api.eu.lever.co`) |
| Workable | Source job listings | Google discovery; unauthenticated GET `https://apply.workable.com/api/v2/accounts/{account}/jobs/{shortcode}` |
| Self-hosted Firecrawl | Extract listing Markdown | HTTP POST `/v2/scrape`; `FIRECRAWL_URL` defaults to `http://127.0.0.1:3002` |
| OpenAI authentication | ChatGPT subscription sign-in and token refresh | OAuth using the public Codex client and loopback callback on port 1455 |
| ChatGPT subscription backend | Independent location and stack assessments | HTTPS POST to undocumented `backend-api/codex/responses`, SSE streaming, strict JSON-schema output |

`src/integrations/llm/types.ts` defines the provider contract and consumes core decision types. `createLlm` in composition currently supports only `MODEL_PROVIDER=chatgpt`; unsupported values fail explicitly. The ChatGPT provider is constructed lazily and reused within the process. `MODEL_NAME` defaults to `gpt-6-luna` and `MODEL_EFFORT` to `medium`. Assessment functions require saved listing text and validate returned decisions before persistence. Ashby requests retrieve the entire board without caching; Greenhouse, Lever, and Workable requests retrieve a single posting. All four use a 75-second timeout and caller cancellation. The Lever client validates request UUID/region, response UUID, plain text, and list heading/HTML types while forwarding other metadata unchanged.

## 6. Deployment & Infrastructure

**Cloud provider:** None required; intended for a local machine or self-managed host.

**Key services:** Docker Compose runs `web`, `scheduler`, `workers`, `firecrawl`, `playwright`, and `redis` on a bridge network. Firecrawl starts directly with `node dist/src/index.js` for single-page `/v2/scrape` requests, which run in the API without its NuQ workers, RabbitMQ, or PostgreSQL. Full crawl, batch, and extract workflows are not provisioned. Application services share a read-write checkout bind mount at `/app`, including the database and credentials. There is no application Dockerfile or image build: install dependencies and compile on the host first.

Web, Firecrawl API, and Redis host ports are published on `127.0.0.1` only. Compose uses dependency health checks for relevant worker dependencies, restart policies, bounded JSON-file logs, and shutdown grace periods (two minutes for app services, three for `workers`). The scraper services have resource limits.

App containers use `${UID:-1000}:${GID:-1000}` to keep bind-mounted database and credential writes under the local user's identity. The scheduler and workers services require healthy Redis; workers startup does not depend on Firecrawl health because supported providers use direct APIs. When upgrading from the former service layout, use `docker compose up -d --remove-orphans` to remove the old containers without deleting queue data. The old `fetch-scheduler`, `fetch-worker`, and `review-worker` CLI commands are replaced by `scheduler` and `workers`.

**CI/CD pipeline:** No checked-in `.github` workflow directory; build, checks, tests, and deployment are invoked manually through package scripts and Compose.

**Monitoring and logging:** Console lifecycle/error output and Docker logs; Compose health checks cover Firecrawl API and Redis. Discovery and review consumers emit compact JSON `delivery_started` and `delivery_finished` records with source/stage, delivery ID, attempt/limit, elapsed milliseconds on finish, and listing ID/sanitized URL where applicable. Review outcomes compare SQLite stage state before and after the callback: `checkpoint_saved`, `terminal_crawl`, or `skipped`; these describe observed checkpoint transitions, not proof that this particular callback wrote them. Failure outcomes distinguish `retrying` (attempt allowance remains, not a delivery guarantee) from `exhausted`. Discovery records include added/pending/failure counts and distinguish partial discovery failure from delivery exhaustion; saved pages are still dispatched first. A downstream dispatch error can fail delivery after a checkpoint was saved, so failure records retain current stage state. Errors include bounded name/message/stack, string codes and up to two Error causes, never arbitrary object serialization. URLs omit credentials, query and fragment; common credential assignments are redacted. Arbitrary upstream text and URL paths may still contain sensitive information, so logs remain private. These diagnostics do not log listing bodies or prompts intentionally, and do not change queue policy or persist an event history. Existing integration/lifecycle messages remain human-readable. No dedicated metrics, tracing, or alerting stack is configured.

## 7. Security Considerations

**Authentication:** ChatGPT uses OAuth credentials; Autom.dev uses an API key. The local web UI has no login.

**Authorization:** No multi-user roles or permissions. Localhost Host-header checks and same-origin checks on mutations constrain browser access; requests without an Origin header are allowed. These checks are not a substitute for authentication on a public service.

**Data encryption:** External Autom.dev/OpenAI requests use HTTPS. Local HTTP and Redis connections are not configured for TLS; SQLite, `.env`, and OAuth credentials have no application-level encryption at rest. Keep the checkout, backups, and host private.

**Key practices:**

- Google listing URLs must match supported HTTPS ATS listing shapes; credentials, custom ports, board homepages, and application-form paths are rejected. Tracking parameters/fragments are stripped and Greenhouse hostnames canonicalized. Freehire reuses that identity normalization where applicable, otherwise preserving HTTP(S) links without embedded credentials; it does not fetch those links.
- API mutations require JSON, validated fields/statuses, and bodies no larger than 16 KiB. SQL values use bound parameters.
- Browser rendering uses text nodes for listing text. Model prompts mark scraped content as untrusted data, and model decisions are checked against bounded schemas and runtime validation.
- Secrets and databases are ignored by Git. OAuth credentials are saved through atomic replacement with mode `0600`.
- Firecrawl API authentication is disabled in Compose; retain loopback-only exposure. Playwright drops capabilities and enables `no-new-privileges`.
- Root `profile.ts` is executable configuration imported at runtime: treat it as trusted code, not an untrusted profile upload.

## 8. Development & Testing Environment

**Local setup:** See [README.md](README.md). Use Node.js 22.18+ and pnpm; install with `pnpm install`, configure `.env` from `.env.example`, edit `profile.ts`, and run `pnpm build`. Authenticate with `pnpm job-hunter auth` before model processing. Redis and a running review worker are required for queued assessments; Compose still provisions Firecrawl although supported ATS listings now use direct APIs.

Application configuration/database paths resolve relative to the application directory, not the shell's current directory. Build type-checks the root profile separately, compiles application TypeScript, and copies UI HTML and the Alpine browser script. Node imports the root TypeScript profile at runtime; restart scheduler and workers after profile changes.

**Testing frameworks:** Node's built-in test runner and assertions. Business tests call application operations directly with in-memory SQLite and real API/model adapters, replacing only external HTTP and credential loading. No Redis, consumer startup, queue polling, or retry timers are used for business cases. Temporary database files are used where persistence across connections matters. The default suite requires neither Redis nor Docker. Separately invoked queue checks run actual consumers against an isolated test Redis service; they cover application-owned dispatch, failure bookkeeping, recovery boundaries, and process lifecycle, not BullMQ's deduplication, reconnection, retry engine, or stalled-task guarantees.

Tests are grouped by the behavior they verify, not every dependency they use:

File-backed test fixtures use `tmpdir()` and `join()`, honor the platform's
temporary-directory configuration (including `TMPDIR`), and remove their own
temporary directories on completion.

- `profile.test.mjs`: profile/native-filter validation and loading; `query.test.mjs`: explicit-query normalization and root search scope; `job-url.test.mjs`: ATS URL rules. `freehire.test.mjs`: native request serialization, warnings/errors/rate limits, pagination/age controls, cancellation/timeout, URL safety, full-text assessment handoff, cross-source deduplication, preservation of failed/inactive/completed work, and atomic rollback.
- `workflows.test.mjs`: direct discovery URL acceptance/canonicalization, persistence and dispatch before partial failure; ATS routing and terminal/transient policy, unmatched/no-API scraping and no API-error fallback; saved-text handoff through both real model adapters; independent assessments, checkpoint reuse, cancellation, and inactive/missing/readiness guards. Recording/failing enqueue callbacks verify workflow handoff and rerun recovery after a checkpoint/enqueue interruption without extracting twice or changing saved text/dates. Real in-memory SQLite and fixture external HTTP/credentials make outcomes deterministic without queue delivery.
- `workers.queue.mjs`: queued discovery-to-assessment smoke coverage (including dispatch before partial-search failure), exhausted-delivery bookkeeping, targeted retry/repair, stale failure generations, interrupted replacement enqueue, crawl redelivery fan-out, production review waiting/selection/cancellation, CLI startup/draining/cleanup, and scheduler admission. Each case has isolated temporary SQLite storage and a random queue prefix. Fixture delivery allows one attempt to check exhaustion without exercising BullMQ's retry engine. Run explicitly through `pnpm test:queue` with `TEST_REDIS_URL` (default `redis://127.0.0.1:6380`). Compose's optional `redis-test` service uses the `test` profile, ephemeral storage, and loopback port 6380; the suite removes its namespaces, not the service.
- `sqlite.integration.test.mjs`: persistence, transactions, stage-state transitions, and migrations, without running processors.
- `cli.test.mjs`: command routing, arguments, help, and application-relative paths; `web.test.mjs`: HTTP behavior, local Alpine delivery, server lifecycle, pure UI assessment logic, and the production component's URL, refresh, mutation/rollback, and stale-response transitions under controlled HTTP. Node VM component tests do not exercise Alpine's DOM renderer or establish real-browser scroll/focus behavior.
- `api-clients.test.mjs`: Ashby, Greenhouse, Lever, and Firecrawl request/response contracts, HTTP failures, timeout and cancellation with mocked network responses. `ashby.test.mjs`, `greenhouse.test.mjs`, `lever.test.mjs`, and `firecrawl.test.mjs`: extraction policy and rendering. `workable.test.mjs`: public detail contracts, safe short-link resolution, rendering, HTTP policy, timeout and cancellation. `auth.test.mjs`: authentication, real credential storage, and refresh-to-request integration; `chatgpt.test.mjs`: model adapters constructed with fake credential loading and HTTP transport; `llm.test.mjs`: provider selection.
- `google.test.mjs`: search response validation, pagination, and preservation of completed pages after failures.

Real SQLite is appropriate in HTTP and workflow tests; those suites assert their public behavior rather than duplicating database or adapter contracts. CLI execution accepts optional construction dependencies with lazy production defaults; queue tests supply real isolated queue/store instances. `createChatgpt` accepts a credential loader and HTTP transport, allowing both suites to retain real prompt construction and response validation without paid calls or local OAuth secrets. The suites share external fixtures in `test/fixtures/workflow.mjs`, not a fake or synchronous queue driver. No module replacement or experimental test-runner flags are needed.

| Command | Purpose |
| --- | --- |
| `pnpm build` | Profile type-check, TypeScript compilation, UI/Alpine copy |
| `pnpm check` | Biome lint/format checks, including inline UI code |
| `pnpm test` | Build and run `test/*.test.mjs`; no Redis/Docker required |
| `pnpm test:queue` | Build and run `test/workers.queue.mjs`; isolated test Redis required |

To run the optional queue integration suite locally:

```sh
docker compose --profile test up -d redis-test
pnpm test:queue
docker compose --profile test stop redis-test
```

The test Redis defaults to `redis://127.0.0.1:6380`; override it with `TEST_REDIS_URL`. Tests clean up their isolated queue namespaces and temporary storage, not the Redis service.

**Code quality tools:** TypeScript and Biome 2.5.15. No frontend bundler is needed. Tests do not require paid search/model calls.

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

**Date of last update:** 2026-10-23.

## 11. Glossary / Acronyms

- **ATS:** Applicant tracking system; the hosted job boards targeted by discovery.
- **Autom.dev:** API provider used to retrieve Google search results.
- **BullMQ:** Redis-backed task queue used for independent processing stages.
- **Crawl:** Extract and persist listing text through Ashby's, Greenhouse's, Lever's, or Workable's public API; Firecrawl remains for unmatched hosts.
- **Eligibility:** Assessment of whether the candidate can perform the job remotely from their residence.
- **Stack assessment:** Independent comparison of a role's core technologies with configured skill groups.
- **Stage:** One processing unit: `crawl`, `location`, or `stack`.
- **Terminal:** Permanent crawl failure; dependent assessments are blocked.
- **Review status:** User-controlled active/hidden/rejected state, separate from model decisions.
- **Repair:** Restore missing pending queue delivery without granting more attempts to failed stages.
- **Backfill:** Explicitly schedule missing historical stack assessments without resetting location decisions.
- **OAuth:** Delegated authorization used for ChatGPT subscription access.
- **SSE:** Server-sent events; the streaming response format consumed by the ChatGPT integration.
