# Job Hunter

Job Hunter finds job listings, assesses them against your CV and preferences,
and puts the results in a local inbox.

## Quickstart

You need Git, Node.js 22.18 or later, pnpm, Docker with Compose, and access to
a ChatGPT account for authentication. Discovery and assessments may incur costs.

1. Clone and install:

   ```sh
   git clone https://github.com/lemuelflores/job-hunter.git
   cd job-hunter
   pnpm install
   cp .env.example .env
   ```

2. Edit `discovery.ts` to match your search. Both Google and Freehire are enabled
   by default. For Google, obtain an API key from [Autom](https://autom.dev/)
   and set `AUTOM_API_KEY` in `.env`; otherwise set `google.enabled` to `false`
   in `discovery.ts`. See [`.env.example`](.env.example) for the configuration
   defaults.

3. Create `cv.md` and `candidate-profile.md` in the project root. Describe your
   experience in the CV and your job preferences and constraints in the profile.

4. Sign in with ChatGPT, following the terminal's instructions:

   ```sh
   pnpm job-hunter auth
   ```

5. Start the application:

   ```sh
   docker compose up -d
   ```

6. Queue a discovery run without waiting for the schedule:

   ```sh
   pnpm job-hunter fetch freehire
   ```

   This prints a queued task ID. With workers running, discovered listings are
   processed and appear in the inbox at <http://localhost:3000>; the inbox can
   remain empty if no listings are found. This command requires Freehire to be
   enabled in `discovery.ts`.

Your CV, profile, credentials and database are private local data. The inbox is
for a trusted local user, not public access.

For other commands, run `pnpm job-hunter --help`.

## Development

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm check
pnpm test
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for how the code is organized.
