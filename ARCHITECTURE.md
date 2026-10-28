# Architecture

Job Hunter is a local, single-user application for discovering job listings,
assessing them against a candidate's CV and preferences, and organizing the
results. It is one TypeScript application with separate CLI, scheduler, worker,
and web execution roles—not a collection of independent services.

This guide describes the current design. See [README.md](README.md) for setup,
commands, and everyday operation. Provider contracts and edge cases live beside
their implementations and tests.

## System at a glance

```text
discovery.ts + environment
         |
CLI / scheduler --> discovery queues --> search providers
                              |
                              v
                       SQLite: listing URLs
                              |
                         crawl queue
                              |
                 public ATS API / Firecrawl
                              |
                              v
                       SQLite: saved text
                              |
                       assessment queue
                              |
                  LLM <-- CV + candidate profile
                              |
                              v
             SQLite: assessments and review status <--> Next.js UI and API <--> Browser
```

SQLite is authoritative for listings, assessments, and processing state. BullMQ
and Redis deliver work; listing-stage payloads carry IDs rather than listing text
or model results. The scheduler only produces discovery tasks. A shared workers
process runs discovery, extraction, and assessment consumers. The web process
reads saved results, changes review status, and requests explicit retries; it
does not run assessments.

Both discovery sources, Google and Freehire, feed the same crawl-first pipeline.
Crawling uses a registered ATS's public API when available and Firecrawl otherwise.
Native API failures never trigger a scraping fallback. The single holistic
assessment uses saved source text, not search snippets or Freehire descriptions,
which may be truncated. A hard stop does not suppress the rest of the report.

## Code map and dependency boundaries

| Module | Responsibility and useful landmarks |
| --- | --- |
| `src/core/` | Provider-independent listings, decisions, and stages. Start with `listing.ts` and `stages.ts`. Imports no outer layer. |
| `src/integrations/` | External capabilities: `search/`, `ats/`, `llm/`, and Firecrawl. Owns HTTP contracts, validation, rendering, and provider-specific policy; imports no workflow, storage, queue, or entrypoint code. |
| `src/workflow/` | Application operations: discovery, crawl, assessment, manual backfill, and review orchestration. Owns readiness checks, checkpoint reuse, persistence, and downstream handoff. |
| `src/infra/` | `sqlite.ts` owns schema, migrations, transactions, and stage transitions. `bullmq.ts` owns delivery, retries, failure reconciliation, and recovery. `candidate-documents.ts` loads the private CV and profile. |
| `src/entrypoints/` | `compose.ts` assembles the ATS registry and lazy concrete dependencies. CLI, scheduler, and worker adapters own process wiring and lifecycle, not business logic. |
| `src/app/` | Next.js React inbox, Node route handlers, request validation, and the mapping from saved data to browser-safe results. `src/proxy.ts` enforces local Host checks. |

Workflows receive integration capabilities and the concrete `SqliteStore`; there
is deliberately no generic repository layer. They do not import concrete
providers, BullMQ, or entrypoints. Discovery and crawl own downstream dispatch
through `EnqueueStage`; infrastructure supplies delivery and failure-sync
callbacks. This keeps the same application operations callable outside workers.

Provider code is co-located by feature. An ATS module owns its URL identity rules,
definition, optional API client, and extraction policy. Low-level HTTP functions
validate the fields the application interprets and return typed data; they do not
perform persistence or orchestration. Metadata that is only forwarded stays
opaque rather than becoming a model of the provider's entire schema.

## Where to make changes

- **Add an ATS:** implement its definition in `src/integrations/ats/` and register
  it in `ATS_DEFINITIONS` in `src/entrypoints/compose.ts`. CLI choices, Google
  scopes, discovery queues, and scheduler/worker fan-out derive from that registry;
  do not add per-provider branches to entrypoints or workflows.
- **Change discovery:** use `src/integrations/search/` for upstream requests and
  URL acceptance, and `src/workflow/discover.ts` for persistence and handoff.
- **Change extraction:** use the ATS module or `src/integrations/firecrawl.ts` for
  source-specific behavior; `src/workflow/crawl.ts` owns strategy selection and
  checkpointing. Shared contracts and page errors live in
  `src/integrations/extraction.ts`.
- **Change assessments:** prompts and authentication belong in
  `src/integrations/llm/`, the persisted response contract in
  `src/core/assessment.ts`, and readiness in `src/workflow/assess-job.ts`.
- **Change storage or recovery:** start in `src/infra/sqlite.ts` or `bullmq.ts`,
  respectively. Keep domain checkpoints separate from delivery state.
- **Change review UI/API:** start in `src/app/`. The React inbox consumes the
  route handlers; request validation, status updates, and retries remain on the
  server.

Node executes backend TypeScript directly; TypeScript checks types. Next.js is
the production and development web entrypoint. The inbox and listing URLs are
server-rendered from SQLite, then refreshed in the browser. Node route handlers
open and close SQLite per request, and open Redis only for retry. `JOB_HUNTER_WEB_PORT`
must match the listening port so Host checks remain meaningful. The browser
never receives candidate documents or saved listing text as raw inputs.

## State, failure, and concurrency invariants

- **Three separate state dimensions:** processing checkpoints, model decisions,
  and user review status are not interchangeable. Hiding or restoring a listing
  does not enqueue processing.
- **Checkpoints survive redelivery:** saving a result and completing its stage is
  one SQLite transaction. Completed work is reused, not overwritten. Rediscovery
  does not reset saved text, decisions, review status, or exhausted stages.
- **Historical work is opt-in:** migration and rediscovery never create a new
  assessment stage for old listings. Bounded backfill selects eligible saved
  text explicitly; old location and stack decisions remain historical and are
  not converted into holistic assessments.
- **Delivery is not a transaction with SQLite:** a crash can leave saved work
  without its downstream enqueue, or repeat an external call before its result is
  saved. Operations must remain checkpoint-aware; `repair` restores missing
  pending delivery without granting failed stages more attempts.
- **Failures have different meanings:** transient extraction/model failures use
  bounded delivery retries. Permanent listing-page failures terminate crawling
  and block assessment. Explicit `retry` resets an exhausted stage; retry
  generations prevent stale Redis failures from undoing that reset.
- **Partial discovery is useful:** successful pages are saved and dispatched
  before reporting a later-page failure. Discovery runs are not automatically
  retried as a whole, because repeating paid searches has a cost.
- **Concurrency is per queue:** each queue admits one active task, while different
  queues can overlap. Consumers share process resources and drain active work
  before shutdown. OAuth refresh coordination is process-local; additional worker
  processes require reconsidering shared credential writes and token rotation.

Discovery provenance and first-seen time are preserved across rediscovery.
Publication dates represent source posting dates, never catalogue creation or
update times. Root `discovery.ts` contains search settings; the private `cv.md`
and `candidate-profile.md` supply candidate evidence and preferences. The worker
rereads them before each assessment; prompts belong to the application.

## Trust and deployment boundaries

The application assumes one trusted local user. The web UI has no login;
loopback exposure, Host checks, and same-origin mutation checks are not a public
service authentication scheme. Listing/model text is untrusted: integrations
validate interpreted fields, prompts separate all three input documents from instructions,
and the browser renders text rather than listing-supplied HTML.

Compose runs the application roles alongside Redis and self-hosted Firecrawl
with its browser service. Application processes share the checkout, SQLite file,
and OAuth credentials. SQLite, Redis, and credentials have separate persistence
and backup needs; Redis is not a replacement for domain storage. Secrets and
credentials and candidate documents are local plaintext files and must remain
private. All application containers share the checkout and can access those
files; browser access is restricted separately. Root `discovery.ts` is executable,
trusted configuration. Unmatched listing URLs reach the scraper,
so its network access must remain within trusted deployment boundaries.

The ChatGPT subscription integration uses unofficial endpoints, and some public
ATS APIs are undocumented. Keep upstream assumptions inside their adapters.

The current queues use the `job-hunter-v2` prefix; legacy deliveries remain inert,
not deleted or replayed. Old and new workers must not run together. See the
README for upgrade and rollback precautions.

## Verification strategy

The default Node test suite exercises application operations directly with real
in-memory SQLite and real adapters, replacing external HTTP and credential
loading. It needs neither Redis nor paid calls. Start with
`test/workflows.test.mjs` for pipeline behavior, provider-named suites for adapter
contracts, `test/sqlite.integration.test.mjs` for storage, and
`test/inbox-api.test.mjs` for the current HTTP boundary.

`test/web-next.browser.mjs` provides an opt-in production-mode browser smoke
against an isolated database. Browser-state tests alone cannot establish real
rendering, scroll, or focus behavior. `test/workers.queue.mjs` separately checks
application-owned delivery, recovery, and lifecycle against isolated Redis
namespaces; it does not retest BullMQ's retry engine. Run it with
`pnpm test:queue`. See the README and `package.json` for other verification
commands.
