This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Beacon is a multi-tenant Agile workspace **backend API** (NestJS 11 + Prisma 7 + PostgreSQL). Multiple organizations operate in full data isolation, each with projects → sprints → tasks, plus memberships, invitations, comments, attachments, labels, notifications, and an immutable audit log. There is no frontend in this repo.

## Commands

The package manager is **pnpm** (do not use npm/yarn).

```bash
pnpm start:dev          # run with watch (dev)
pnpm build              # nest build → dist/
pnpm type-check         # tsc --noEmit (run this after changes; CI enforces it)
pnpm lint               # eslint --fix over {src,apps,libs,test}
pnpm format             # prettier --write src

pnpm test               # jest (unit; *.spec.ts under src/)
pnpm test:watch
pnpm test:cov
pnpm test:e2e           # jest with test/jest-e2e.json
# run a single test file:
pnpm test -- src/modules/tasks/tasks.service.spec.ts
# run tests matching a name:
pnpm test -- -t "should create a task"

pnpm prisma:generate    # regenerate client into src/generated/prisma (REQUIRED after schema edits)
pnpm prisma:migrate     # migrate dev
pnpm prisma:db:seed     # seed (tsx prisma/seed.ts)
pnpm prisma:studio
```

CI (`.github/workflows/ci.yml`) runs on Node 22 and gates PRs to `master` with: prisma generate → type-check → lint → test (unit only) → build. Match all five locally before pushing. Pre-commit hooks run via Husky.

## Architecture

### Request pipeline (global, wired in `src/main.ts` + `src/app.module.ts`)
Helmet → CORS → **ValidationPipe** (`whitelist`, `forbidNonWhitelisted`, `transform`) → **ThrottlerGuard** (global) → **JwtAuthGuard** (global) → route guards → controller → **TransformInterceptor** wraps every response as `{ data, meta: { timestamp } }` → **GlobalExceptionFilter** normalizes errors. All routes are under the `/api` global prefix; Swagger is served at `/api/docs`.

### Auth & authorization (the core of multi-tenancy — read `src/common/guards/` first)
- **`JwtAuthGuard`** is registered globally (`APP_GUARD`). Every route requires a valid JWT **unless** marked with `@Public()`. It attaches the decoded `JwtPayload` to `request.user`.
- **`OrgMemberGuard`** and **`RolesGuard`** are applied per-controller/route via `@UseGuards(...)`. Both resolve the tenant (`orgId`) from the request, then verify the user's `Membership` in that org. `SUPER_ADMIN` global role bypasses both.
- **Org resolution is implicit and shared** between `OrgMemberGuard` and `RolesGuard` (their `resolveOrgId` methods are near-duplicates): it derives the org from `:orgId`, else from `:projectId` (via Project), else from `:taskId` (via Task), else from a generic `:id` (org or label). Resolved values are stashed on the request (`projectOrgId`, `taskOrgId`, `taskProjectId`, `labelOrgId`) for downstream use by the audit interceptor. When adding routes with new param shapes, extend this resolution logic.
- **Roles** use a hierarchy: `OWNER(4) > ADMIN(3) > MEMBER(2) > VIEWER(1)`. `@Roles(...)` requires the *minimum* of the listed roles. Access requires membership `role` level ≥ that minimum.
- **Dual-track note (important)**: alongside the guard pair above, a second, project-granular track exists under `src/common/authorization/` (`ProjectAccessGuard`, `ProjectGrants`, `project-policy`, `resource-context.resolver`), heavily used by the monitoring domain (`monitors`, `monitoring`, `checker`, `state`, `rules`, `rule-bindings`, `alert-events`) and covered by its own specs plus `test/project-access/*`. Selection rule for new routes: **tenant/org-scoped resources** (organizations, memberships, invitations, billing, developer credentials, admin surfaces) → old track (`OrgMemberGuard` + `RolesGuard`); **project-scoped resources** (monitors, checks, rules, state, alerting) → new track (`ProjectAccessGuard`). Do not stack both tracks on the same route family with conflicting semantics; follow the guard choice of similar existing controllers. Full boundary notes live in `docs/AUTHORIZATION.md` (local-only, `/docs` is gitignored).

### Audit logging (decorator-driven, opt-in)
Annotate a controller method with `@AuditLog({ entity: 'Task' })`. The `AuditLogInterceptor` (see `src/common/interceptors/audit-log.interceptor.ts`) then: infers the action from the HTTP method (POST→CREATE, PATCH/PUT→UPDATE, DELETE→DELETE), fetches a **before** snapshot for mutating actions by dynamically resolving the Prisma model delegate from the entity name, captures **after** from the response, strips sensitive fields (`password`, `token`, `refreshToken`), and writes the log **fire-and-forget** (never blocks or fails the response). Org/project IDs come from the guard-resolved request values above.

### Modules (`src/modules/*`)
Each feature is a standard Nest module (`*.module.ts` / `*.controller.ts` / `*.service.ts`, with `dto/` and `entities/`): `auth`, `users`, `organizations`, `memberships`, `invitations`, `projects`, `sprints`, `tasks`, `comments`, `attachments`, `labels`, `notifications`, `audit-logs`, `email`, `cron`. Controllers are thin (Swagger decorators + guards + DTO binding); business logic and all Prisma access live in services.

- **`cron`** (`@nestjs/schedule`): scheduled jobs for invitation expiry, task due-soon/overdue alerts, and token cleanup (`src/modules/cron/jobs/`).
- **`email`**: transactional email via Resend.
- **`attachments`**: first-party attachment upload via Nest controllers. Files upload through `POST /api/tasks/:taskId/attachments/upload` and are stored by the local/OSS `StorageService`; metadata remains in the `Attachment` table.
- **`notifications`**: in-app + real-time via Server-Sent Events (SSE).
- **`monitoring` / `monitors` / `checker` / `state` / `rules` / `notifier` / `alert-events` / `status-pages`**: monitoring platform for uptime checks, probe execution/results, alerting rules and bindings, notification channels/deliveries, alert events, and public status pages.
- **`probes`**: probe enrollment/ingest and probe management (agent-facing endpoints and org-scoped management).
- **`billing`**: plans, subscriptions, quotas, orders and payments (includes WeChat Pay callback handling).
- **`developer-api`**: API credentials (API keys/PATs) and developer v1 endpoints for managing monitors/probes/status-pages.
- **`admin`**: admin-only surfaces for tenants, orders, audit logs, metrics, and system probes.
- **`settings`**: admin/system settings management.
- **`organizations`**: tenant CRUD, plus the onboarding bootstrap. `OrganizationsService.provisionForUser` creates a starter organization (user as `OWNER`, plus the matching `Membership`) and its first project. It is idempotent (skips users who already belong to any org) and is called from `AuthService.verifyEmail` inside the same transaction that flips `emailVerified`, so a verified user always ends up with a usable organization.

### Data layer
- Prisma schema: `prisma/schema.prisma` (18 models). Connects to PostgreSQL via the `@prisma/adapter-pg` driver adapter. Prisma config lives in `prisma.config.ts`, not `package.json`.
- **Historical note**: the first two migrations form a duplicate init pair (`20260301210328_init` creates a minimal `User` table; `20260303224956_init` drops it and rebuilds the full schema). This is expected — do NOT rewrite or squash applied migration history.
- **The generated client is NOT committed.** It is generated to `src/generated/prisma/` via `pnpm prisma:generate` and ignored by Git (output redirected there). Import enums from `src/generated/prisma/enums` and models from `src/generated/prisma/models`. **Re-run `pnpm prisma:generate` after any schema change** or the build/types will be stale. This is required for local development, CI, and builds.
- `PrismaService` (`src/database/`) is the injectable client; inject it into services.
- **Soft deletes**: organizations, projects, tasks, and comments use a `deletedAt` column. Queries must filter `deletedAt: null` (the guards already do this when resolving tenants) — follow the existing pattern rather than hard-deleting.

### Config
Typed config via `@nestjs/config` `registerAs` factories in `src/config/` (`app`, `database`, `jwt`, `resend`, `throttler`), loaded globally in `app.module.ts` and read with `configService.get<XConfig>('x')`. Env helpers `requireEnv`/`optionalEnv` in `src/config/env.ts`. See `.env.example` for required variables.

## Conventions
- Prettier: **4-space indent**, single quotes, trailing commas (`all`). TypeScript strict-ish (`strictNullChecks` on, `noImplicitAny` off). Match the existing style; run `pnpm format` / `pnpm lint`.
- New endpoints: decorate with Swagger (`@ApiTags`, `@ApiOperation`, response decorators) as existing controllers do — the live docs are generated from these.
- Mark unauthenticated routes with `@Public()`; get the current user with `@CurrentUser()`; guard tenant routes with `OrgMemberGuard`/`RolesGuard`; audit mutations with `@AuditLog()`.
- Branching: work off `master`; PRs target `master` (squash merged after CI passes).
