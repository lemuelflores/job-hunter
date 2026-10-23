# Architecture

Job Hunter is a local, single-user application for discovering job listings,
assessing remote-location eligibility and technology fit, and organizing the
results. It is one TypeScript application with separate CLI, scheduler, worker,
and web execution roles—not a collection of independent services.

This guide describes the checked-in design. See [README.md](README.md) for setup,
commands, and everyday operation. Provider contracts and edge cases live beside
their implementations and tests.

## System at a glance

```text
profile.ts + environment
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
                   +----------+----------+
                   |                     |
             location queue         stack queue
                   |                     |
                   +--> LLM assessments <-+
                              |
                              v
Browser <--> local HTTP server <--> SQLite: results and review status
```

SQLite is authoritative for listings, assessments, and processing state. BullMQ
and Redis deliver work; listing-stage payloads carry IDs rather than listing text
or model results. The scheduler only produces discovery tasks. A shared workers
process runs discovery, extraction, and assessment consumers. The web process
reads saved results and changes review status; it does not run the pipeline.

Both discovery sources, Google and Freehire, feed the same crawl-first pipeline.
Crawling uses a registered ATS's public API when available and Firecrawl otherwise.
Native API failures never trigger a scraping fallback. Both assessments use the
saved source text, not search snippets or Freehire descriptions, which may be
truncated. Location and technology checks are independent: location rejection
does not suppress the technology check.

## Code map and dependency boundaries

| Module | Responsibility and useful landmarks |
| --- | --- |
| `src/core/` | Provider-independent listings, decisions, candidate preferences, and stages. Start with `listing.ts`, `profile.ts`, and `stages.ts`. Imports no outer layer. |
| `src/integrations/` | External capabilities: `search/`, `ats/`, `llm/`, and Firecrawl. Owns HTTP contracts, validation, rendering, and provider-specific policy; imports no workflow, storage, queue, or entrypoint code. |
| `src/workflow/` | Application operations: discovery, crawl, location/technology checks, and review orchestration. Owns readiness checks, checkpoint reuse, persistence, and downstream handoff. |
| `src/infra/` | `sqlite.ts` owns schema, migrations, transactions, and stage transitions. `bullmq.ts` owns delivery, retries, failure reconciliation, and recovery. `config.ts` assembles executable configuration. |
| `src/entrypoints/` | `compose.ts` assembles the ATS registry and lazy concrete dependencies. CLI, scheduler, and worker adapters own process wiring and lifecycle, not business logic. |
| `src/web/` | `server.ts` owns the local HTTP boundary; `index.html` contains the browser UI in one Alpine component, without a frontend bundler. |

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
- **Change assessments:** prompts, response contracts, and authentication belong
  in `src/integrations/llm/`; readiness and persistence belong in
  `src/workflow/location-check.ts` and `tech-check.ts`. The existing persisted and
  queue stage name for technology checks is `stack`.
- **Change storage or recovery:** start in `src/infra/sqlite.ts` or `bullmq.ts`,
  respectively. Keep domain checkpoints separate from delivery state.
- **Change review UI/API:** start in `src/web/`. Browser state and rendering stay
  in `index.html`; request validation and persistence stay in `server.ts`.

## State, failure, and concurrency invariants

- **Three separate state dimensions:** processing checkpoints, model decisions,
  and user review status are not interchangeable. Hiding or restoring a listing
  does not enqueue processing.
- **Checkpoints survive redelivery:** saving a result and completing its stage is
  one SQLite transaction. Completed work is reused, not overwritten. Rediscovery
  does not reset saved text, decisions, review status, or exhausted stages.
- **Delivery is not a transaction with SQLite:** a crash can leave saved work
  without its downstream enqueue, or repeat an external call before its result is
  saved. Operations must remain checkpoint-aware; `repair` restores missing
  pending delivery without granting failed stages more attempts.
- **Failures have different meanings:** transient extraction/model failures use
  bounded delivery retries. Permanent listing-page failures terminate crawling
  and block dependent checks. Explicit `retry` resets an exhausted stage; retry
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
update times. Root `profile.ts` contains candidate preferences and native search
settings; prompts and assessment rules belong to the application.

## Trust and deployment boundaries

The application assumes one trusted local user. The web UI has no login;
loopback exposure, Host checks, and same-origin mutation checks are not a public
service authentication scheme. Listing/model text is untrusted: integrations
validate interpreted fields, prompts separate listing content from instructions,
and the browser renders text rather than listing-supplied HTML.

Compose runs the application roles alongside Redis and self-hosted Firecrawl
with its browser service. Application processes share the checkout, SQLite file,
and OAuth credentials. SQLite, Redis, and credentials have separate persistence
and backup needs; Redis is not a replacement for domain storage. Secrets and
credentials are local plaintext files and must remain private. Root `profile.ts`
is executable, trusted configuration. Unmatched listing URLs reach the scraper,
so its network access must remain within trusted deployment boundaries.

The ChatGPT subscription integration uses unofficial endpoints, and some public
ATS APIs are undocumented. Keep upstream assumptions inside their adapters.

## Verification strategy

The default Node test suite exercises application operations directly with real
in-memory SQLite and real adapters, replacing external HTTP and credential
loading. It needs neither Redis nor paid calls. Start with
`test/workflows.test.mjs` for pipeline behavior, provider-named suites for adapter
contracts, `test/sqlite.integration.test.mjs` for storage, and `test/web.test.mjs`
for HTTP and browser-state logic.

`test/workers.queue.mjs` separately exercises application-owned delivery,
recovery, and lifecycle behavior against isolated Redis namespaces. It does not
retest BullMQ's retry engine. Browser-state tests do not establish real-browser
rendering, scroll, or focus behavior. Use `pnpm build`, `pnpm check`, and the
relevant test suites for code changes; queue checks are explicitly opt-in.
