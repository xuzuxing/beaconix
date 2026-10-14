# Contributing to Beacon

Thanks for your interest in improving Beacon. This guide covers everything you
need to set up the project, make a change, and get it merged.

By participating you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Prerequisites

| Tool | Version |
|---|---|
| Node.js | 22 or newer |
| pnpm | 11 (`packageManager` in `package.json`) |
| PostgreSQL | 16 (or use `docker-compose.yml`) |

## Local Setup

```bash
git clone https://github.com/xuzuxing/beaconix.git
cd beaconix
pnpm install
cp .env.example .env        # then fill in the required values
pnpm prisma:generate        # regenerate the committed Prisma client
pnpm prisma:migrate         # apply migrations to your local database
pnpm start:dev              # http://localhost:3000/api (docs at /api/docs)
```

`pnpm install` also installs the Husky git hooks and runs `pnpm prisma:generate`
as part of `prisma` tooling, so run it before your first type check.

## Daily Commands

| Command | Purpose |
|---|---|
| `pnpm start:dev` | Run in watch mode |
| `pnpm type-check` | `tsc --noEmit` |
| `pnpm lint` | ESLint with `--fix` |
| `pnpm format` | Prettier over `src/**/*.ts` |
| `pnpm test` | Unit tests (Jest, `*.spec.ts` under `src/`) |
| `pnpm test:e2e` | E2E tests (`test/jest-e2e.json`) |
| `pnpm build` | Compile to `dist/` |

Run `pnpm type-check`, `pnpm lint`, and `pnpm build` locally before opening a
pull request — CI runs exactly these three (after `prisma generate`) and will
block the merge otherwise.

## Branching and Pull Requests

The default and only long-lived branch is **`master`**. Work on short-lived
branches cut from it and open your pull request against `master`.

```bash
git checkout master
git pull
git checkout -b feat/task-dependencies
```

Branch prefixes:

| Prefix | Usage |
|---|---|
| `feat/` | New feature |
| `fix/` | Bug fix |
| `chore/` | Maintenance, dependencies, config |
| `docs/` | Documentation only |
| `refactor/` | Code restructuring |
| `test/` | Adding or updating tests |

Pull request expectations:

- One focused change per PR; keep unrelated refactors out.
- Fill in the [pull request template](.github/PULL_REQUEST_TEMPLATE.md).
- CI must pass; merges are squash-only, so the PR title becomes the commit
  subject. Use a conventional prefix (`feat`, `fix`, `refactor`, `chore`,
  `docs`, `test`) as described in the template.
- Never commit secrets. `.env` is gitignored — document new variables in
  `.env.example` instead.

## Code Style

- Prettier is the source of truth: 4-space indent, single quotes, trailing
  commas. Run `pnpm format` before committing.
- ESLint must pass (`pnpm lint`).
- Follow the existing NestJS structure: thin controllers (Swagger decorators,
  guards, DTO binding) and services that own the business logic and all Prisma
  access. See [`CLAUDE.md`](CLAUDE.md) for an architecture walkthrough.
- New endpoints: decorate with `@ApiTags`/`@ApiOperation`/response decorators,
  mark unauthenticated routes with `@Public()`, guard tenant routes with
  `OrgMemberGuard`/`RolesGuard`, and audit mutations with `@AuditLog()`.

A Husky `pre-commit` hook runs the TypeScript type check, a Prettier formatting
check, and ESLint. Fix the reported problems rather than bypassing the hook.

## Database Changes

`prisma/schema.prisma` is the single source of truth, and the generated client is
committed under `src/generated/prisma/`.

```bash
# after editing prisma/schema.prisma
pnpm prisma:generate        # required — otherwise types/build are stale
pnpm prisma:migrate         # creates prisma/migrations/<timestamp>_<name>
```

Commit the schema change, the migration, and the regenerated client together in
one commit.

## Tests

Tests use Jest (`pnpm test` for unit tests, `pnpm test:e2e` for e2e). New
functionality should ship with tests, and bug fixes with a regression test.
Place unit tests next to the code as `<name>.spec.ts`.

```bash
pnpm test -- src/modules/tasks/tasks.service.spec.ts   # single file
pnpm test -- -t "should create a task"                 # by test name
pnpm test:cov                                          # coverage
```

## Security

Please do not report vulnerabilities in public issues. See
[SECURITY.md](SECURITY.md) for the private reporting process.
