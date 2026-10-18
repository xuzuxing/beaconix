<img src="./docs/images/banner.png" alt="Beaconix Banner" width="100%" />
<p align="center">
  A production-ready, multi-tenant Agile Workspace backend for managing organizations, projects, sprints, and tasks. built with NestJS, Prisma, and PostgreSQL.
</p>

<p align="center">
  <img src="https://shieldcn.dev/badge/NestJS-11-E0234E.svg?logo=nestjs&logoColor=white" alt="NestJS 11" />
  <img src="https://shieldcn.dev/badge/Prisma-7.8-2D3748.svg?logo=prisma&logoColor=white" alt="Prisma 7.8" />
  <img src="https://shieldcn.dev/badge/PostgreSQL-16-4169E1.svg?logo=postgresql&logoColor=white" alt="PostgreSQL 16" />
  <img src="https://shieldcn.dev/badge/TypeScript-6.0-3178C6.svg?logo=typescript&logoColor=white" alt="TypeScript 6.0" />
  <img src="https://shieldcn.dev/badge/Node.js-22-5FA04E.svg?logo=nodedotjs&logoColor=white" alt="Node.js 22" />
  <img src="https://shieldcn.dev/badge/Docker-ready-2496ED.svg?logo=docker&logoColor=white" alt="Docker ready" />
  <a href="https://beaconix.app/api/docs"><img src="https://shieldcn.dev/badge/API_Docs-Swagger-85EA2D.svg?logo=swagger&logoColor=white" alt="API Docs" /></a>
</p>

---

## Table of Contents

- [Overview](#overview)
- [Key Features](#key-features)
- [Live API Documentation](#live-api-documentation)
- [Project Documentation](#project-documentation)
- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
  - [High-Level Architecture](#high-level-architecture)
  - [Request Lifecycle](#request-lifecycle)
  - [Multi-Tenant Data Model](#multi-tenant-data-model)
  - [Entity Relationship Diagram](#entity-relationship-diagram)
  - [Authentication Flow](#authentication-flow)
  - [Role-Based Access Control](#role-based-access-control)
  - [Notification System](#notification-system)
- [Project Structure](#project-structure)
- [API Reference](#api-reference)
  - [Auth](#auth-endpoints)
  - [Organizations](#organizations-endpoints)
  - [Memberships](#memberships-endpoints)
  - [Invitations](#invitations-endpoints)
  - [Projects](#projects-endpoints)
  - [Sprints](#sprints-endpoints)
  - [Tasks](#tasks-endpoints)
  - [Comments](#comments-endpoints)
  - [Attachments](#attachments-endpoints)
  - [Labels](#labels-endpoints)
  - [Notifications](#notifications-endpoints)
  - [Audit Logs](#audit-logs-endpoints)
  - [Monitoring](#monitoring-endpoints)
  - [Probes](#probes-endpoints)
  - [Status Pages](#status-pages-endpoints)
  - [Notification Channels](#notification-channels-endpoints)
  - [Developer Access](#developer-access-endpoints)
  - [Billing](#billing-endpoints)
  - [Admin](#admin-endpoints)
  - [WeChat Auth](#wechat-auth-endpoints)
- [Database Schema](#database-schema)
- [Cron Jobs](#cron-jobs)
- [Email Templates](#email-templates)
- [Security](#security)
- [Development and Deployment Workflow](#development-and-deployment-workflow)
  - [Git Branching Strategy](#git-branching-strategy)
  - [Pre-Commit Hooks](#pre-commit-hooks)
  - [Dependabot](#dependabot)
  - [CI Pipeline](#ci-pipeline)
  - [Deployment Pipeline](#deployment-pipeline)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
  - [Environment Variables](#environment-variables)
  - [Running the Application](#running-the-application)
  - [Docker](#docker)
- [Contributing](#contributing)
- [License](#license)

---

## Overview

BeaconFlow is a **SaaS-style, multi-tenant Agile project management platform** designed for teams that follow agile methodologies. It provides a complete backend system where multiple organizations operate in full isolation from one another, each with their own projects, sprints, tasks, and members.

The current codebase keeps that Agile workspace foundation and extends it with uptime monitoring, distributed probes, status pages, notification channels, billing, developer API credentials, and WeChat integrations.

**What problem does it solve?**

Managing agile workflows across distributed teams requires robust tooling: organization-level isolation, role-based permissions, sprint planning, task tracking with dependencies, real-time notifications, and a full audit trail. Beacon delivers all of this as a single, self-contained backend API.

**Who is it for?**

- **Development teams** looking for an agile workspace backend they can self-host and extend
- **SaaS builders** who need a reference implementation for multi-tenant architecture with NestJS
- **Engineering leads** evaluating how to structure a production NestJS application with Prisma, JWT auth, RBAC, and audit logging

**What can you do with it?**

- Create and manage **organizations** with invite-based onboarding
- Plan work in **projects** with **sprints** and **backlogs**
- Track **tasks** with priorities, statuses, story points, subtasks, dependencies, labels, attachments, and threaded comments
- Receive **real-time notifications** via Server-Sent Events (SSE) and email
- Review a complete, immutable **audit log** of all platform activity
- Integrate with any frontend, mobile app, or third-party service through a documented REST API

---

## Key Features

| Category | Feature |
|---|---|
| **Multi-Tenancy** | Organization-based data isolation with membership scoping |
| **Authentication** | JWT access + refresh token rotation, email verification via OTP, password reset |
| **Authorization** | Four-tier role hierarchy (Owner, Admin, Member, Viewer) with guard-based enforcement |
| **Organizations** | Create, update, soft-delete, ownership transfer |
| **Invitations** | Token-based email invitations with expiry, accept/decline, and cron-based auto-expiry |
| **Projects** | CRUD, archive/restore, project keys for task identifiers |
| **Sprints** | Lifecycle management (Planned, Active, Completed), ordering |
| **Tasks** | Full lifecycle with priorities, statuses, story points, subtasks, dependencies, assignment, sprint placement |
| **Task Watching** | Users can watch tasks and receive notifications on changes |
| **Task Activity Log** | Automatic timeline of all field changes on a task |
| **Comments** | Threaded (nested) comments with edit tracking and soft-delete |
| **Attachments** | First-party local/OSS file uploads with metadata tracking |
| **Labels** | Organization-wide and project-scoped labels with task tagging |
| **Notifications** | Real-time SSE streaming, in-app read/unread, email alerts |
| **Monitoring** | HTTP/TCP monitors, local checks, probe-assisted checks, state tracking, and check history |
| **Probes** | Tenant and system probes with heartbeat, result ingestion, and validation challenges |
| **Status Pages** | Public status pages backed by selected monitor state |
| **Alert Channels** | Feishu, WeCom, DingTalk, WeChat Subscribe Message, and email notification channels |
| **Billing** | Plans, quotas, subscriptions, orders, WeChat Pay callback support, and expiry jobs |
| **Developer API** | Organization API keys, personal access tokens, scoped `/developer/v1` endpoints |
| **WeChat Login** | Web, mini-program, scan-login, official account, work WeChat, and payment clients |
| **Audit Logging** | Immutable, decorator-driven audit trail with before/after snapshots |
| **Cron Jobs** | Automated invitation expiry, task due-soon/overdue alerts, token cleanup |
| **Email** | Transactional emails via Resend (verification, invitation, password reset, task alerts) |
| **API Documentation** | Interactive Swagger/OpenAPI docs auto-generated from decorators |
| **Rate Limiting** | Configurable throttling on all endpoints |
| **Soft Deletes** | Recoverable deletion for organizations, projects, tasks, and comments |

---

## Live API Documentation

The full interactive API documentation is available at:

**[https://getbeacon.dev/api/docs/api/docs](https://getbeacon.dev/api/docs/api/docs)**

> **Note:** This deployment uses a Render free-tier instance. The server spins down after inactivity, so the first request may take **50 seconds or more** to respond while the instance cold-starts.

---

## Project Documentation

See the [documentation index](docs/README.md) for API references, operational guides, design records, product prototypes, proposals, and historical archives.

---

## Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| **Runtime** | Node.js | JavaScript runtime |
| **Language** | TypeScript (strict mode) | Type safety and developer experience |
| **Framework** | NestJS | Modular, enterprise-grade Node.js framework |
| **ORM** | Prisma with `@prisma/adapter-pg` | Type-safe database access with PostgreSQL driver adapter |
| **Database** | PostgreSQL | Primary relational data store |
| **Authentication** | `@nestjs/jwt` + bcrypt | JWT access/refresh tokens, password hashing |
| **Validation** | `class-validator` + `class-transformer` | DTO validation and transformation pipeline |
| **API Docs** | `@nestjs/swagger` (OpenAPI) | Auto-generated interactive API documentation |
| **Rate Limiting** | `@nestjs/throttler` | Configurable request throttling |
| **Scheduling** | BullMQ scheduled jobs on Redis | Automated background jobs |
| **Queue/Cache** | Redis + BullMQ + node-cache | Scheduled jobs, notification work, and runtime caching |
| **Email** | Resend SDK | Transactional email delivery |
| **File Upload** | Local disk / S3-compatible OSS | Server-side attachment upload and storage abstraction |
| **API Reference UI** | Scalar | Swagger/OpenAPI document viewer at `/reference` |
| **Logging** | Pino / nestjs-pino | Structured request and application logging |
| **Security** | Helmet | HTTP security headers |
| **Containerization** | Docker + Docker Compose | Multi-stage builds, local PostgreSQL |
| **CI/CD** | GitHub Actions | Automated type-check, lint, and build |
| **Deployment** | Render | Cloud hosting with Docker support |
| **Package Manager** | pnpm | Fast, disk-efficient dependency management |
| **Git Hooks** | Husky | Pre-commit quality enforcement |
| **Linting** | ESLint + Prettier | Code style and formatting |

---

## Architecture

### High-Level Architecture

```mermaid
graph TB
    Client["Client Applications<br/>(Web, Mobile, CLI)"]

    subgraph "Beacon Backend"
        API["NestJS API Server<br/>Port 3000"]

        subgraph "Global Layer"
            Helmet["Helmet<br/>Security Headers"]
            CORS["CORS<br/>Origin Control"]
            Throttle["Throttler<br/>Rate Limiting"]
            Validation["ValidationPipe<br/>DTO Validation"]
            Transform["TransformInterceptor<br/>Response Wrapping"]
            ExFilter["GlobalExceptionFilter<br/>Error Handling"]
        end

        subgraph "Auth Layer"
            JWTGuard["JWT Auth Guard"]
            OrgGuard["Org Member Guard"]
            RolesGuard["Roles Guard"]
        end

        subgraph "Feature Modules"
            Auth["Auth Module"]
            Orgs["Organizations Module"]
            Members["Memberships Module"]
            Invites["Invitations Module"]
            Projects["Projects Module"]
            Sprints["Sprints Module"]
            Tasks["Tasks Module"]
            Comments["Comments Module"]
            Attach["Attachments Module"]
            Labels["Labels Module"]
            Notif["Notifications Module"]
            Audit["Audit Logs Module"]
            Cron["Cron Module"]
            Email["Email Module"]
        end
    end

    DB[("PostgreSQL 16")]
    Resend["Resend<br/>Email Service"]
    Storage["Local / OSS<br/>File Storage"]

    Client -->|"HTTPS"| API
    API --> Helmet --> CORS --> Throttle --> Validation --> Transform
    Transform --> ExFilter
    ExFilter --> JWTGuard --> OrgGuard --> RolesGuard

    RolesGuard --> Auth & Orgs & Members & Invites & Projects & Sprints & Tasks & Comments & Attach & Labels & Notif & Audit

    Auth & Orgs & Members & Invites & Projects & Sprints & Tasks & Comments & Attach & Labels & Notif & Audit & Cron -->|"Prisma ORM"| DB
    Email -->|"API"| Resend
    Attach -->|"StorageService"| Storage
    Cron -->|"Scheduled"| Email
    Cron -->|"Scheduled"| Notif
```

### Request Lifecycle

Every HTTP request passes through a consistent pipeline before reaching the business logic:

```mermaid
sequenceDiagram
    participant C as Client
    participant H as Helmet
    participant T as Throttler
    participant V as ValidationPipe
    participant JG as JwtAuthGuard
    participant OG as OrgMemberGuard
    participant RG as RolesGuard
    participant Ctrl as Controller
    participant Svc as Service
    participant AI as AuditLogInterceptor
    participant TI as TransformInterceptor
    participant EF as GlobalExceptionFilter

    C->>H: HTTP Request
    H->>T: Security headers applied
    T->>V: Rate limit check passed
    V->>JG: DTO validated & transformed

    alt Public route (@Public)
        JG->>Ctrl: Skip auth
    else Protected route
        JG->>JG: Verify JWT from Bearer token
        JG->>OG: Attach user to request
        OG->>OG: Verify org membership via params
        OG->>RG: Attach membership to request
        RG->>RG: Check role hierarchy (OWNER > ADMIN > MEMBER > VIEWER)
        RG->>Ctrl: Access granted
    end

    Ctrl->>Svc: Delegate to service layer
    Svc-->>Ctrl: Return result
    Ctrl-->>AI: Response data
    AI->>AI: Write audit log (fire-and-forget)
    AI-->>TI: Pass response
    TI-->>C: Wrap in { data, meta: { timestamp } }

    Note over EF: Catches any unhandled exception<br/>Returns structured error response
```

### Multi-Tenant Data Model

Beacon enforces organization-level isolation. Every piece of data belongs to an organization, and access is verified through membership at the guard level.

```mermaid
graph TD
    User["User"]

    User -->|"owns"| Org["Organization"]
    User -->|"member of"| Membership["Membership<br/>(OWNER | ADMIN | MEMBER | VIEWER)"]
    Membership --> Org

    Org -->|"contains"| Project["Project"]
    Org -->|"contains"| Label["Label (org-wide)"]
    Org -->|"tracks"| AuditLog["Audit Log"]
    Org -->|"sends"| Invitation["Invitation"]

    Project -->|"contains"| Sprint["Sprint"]
    Project -->|"contains"| Task["Task"]
    Project -->|"scopes"| PLabel["Label (project-scoped)"]

    Sprint -->|"holds"| Task

    Task -->|"has"| Comment["Comment"]
    Task -->|"has"| Attachment["Attachment"]
    Task -->|"tagged with"| TaskLabel["TaskLabel"]
    Task -->|"blocks / blocked by"| TaskDep["TaskDependency"]
    Task -->|"watched by"| TaskWatcher["TaskWatcher"]
    Task -->|"logged in"| TaskActivity["TaskActivity"]
    Task -->|"subtask of"| Task
```

### Entity Relationship Diagram

<p align="center">
  <img src="./docs/images/beaconix-erd.png" alt="Beacon Entity Relationship Diagram" />
</p>

<p align="center">
  <a href="https://dbdiagram.io/d/beaconix-6ad0f967aebfe7a21fffaf4b">View interactive ERD on dbdiagram.io</a>
</p>

### Authentication Flow

Beacon uses a stateless JWT access token paired with a rotating refresh token stored in the database. Email verification is enforced via OTP codes.

```mermaid
sequenceDiagram
    participant C as Client
    participant A as Auth API
    participant DB as Database
    participant E as Email (Resend)

    Note over C,E: Registration Flow
    C->>A: POST /api/auth/register {email, password, name}
    A->>DB: Create user (emailVerified=false)
    A->>DB: Create OTP code (hashed, 15min TTL)
    A->>E: Send verification email with 6-digit code
    A-->>C: 201 { message: "Verify your email" }

    C->>A: POST /api/auth/verify-email {email, code}
    A->>DB: Verify OTP hash, mark used
    A->>DB: Set emailVerified=true
    A-->>C: 200 { message: "Email verified" }

    Note over C,E: Login Flow
    C->>A: POST /api/auth/login {email, password}
    A->>DB: Validate credentials + emailVerified
    A->>DB: Create refresh token (hashed, 7d TTL)
    A-->>C: 200 { accessToken (15m), refreshToken (7d), user }

    Note over C,E: Token Refresh
    C->>A: POST /api/auth/refresh {refreshToken}
    A->>DB: Validate token hash, check not revoked/expired
    A->>DB: Revoke old token, create new token pair
    A-->>C: 200 { accessToken, refreshToken }

    Note over C,E: Password Reset
    C->>A: POST /api/auth/forgot-password {email}
    A->>DB: Create OTP code (hashed, 15min TTL)
    A->>E: Send password reset OTP email
    C->>A: POST /api/auth/reset-password {email, code, newPassword}
    A->>DB: Verify OTP, update password hash
    A->>DB: Revoke all refresh tokens for user
    A-->>C: 200 { message: "Password reset successful" }
```

### Role-Based Access Control

The role system uses a strict hierarchy. Higher roles inherit all permissions of lower roles. The `RolesGuard` enforces minimum role requirements on each endpoint.

```mermaid
graph LR
    VIEWER["VIEWER<br/>Read-only access"]
    MEMBER["MEMBER<br/>Create & manage own work"]
    ADMIN["ADMIN<br/>Manage projects, sprints,<br/>members, labels, invitations"]
    OWNER["OWNER<br/>Full control including<br/>delete org & transfer ownership"]

    VIEWER -->|"inherits"| MEMBER -->|"inherits"| ADMIN -->|"inherits"| OWNER

    SA["SUPER_ADMIN<br/>(Global Role)"]
    SA -.->|"bypasses all<br/>role & membership checks"| OWNER
```

| Role | Permissions |
|---|---|
| **VIEWER** | View organizations, projects, sprints, tasks, comments, labels, attachments |
| **MEMBER** | All Viewer permissions + create tasks, comments, attachments; watch tasks; manage own work |
| **ADMIN** | All Member permissions + manage projects, sprints, labels, members, invitations; view audit logs |
| **OWNER** | All Admin permissions + delete organization, transfer ownership |
| **SUPER_ADMIN** | Global role that bypasses all membership and role checks across every organization |

### Notification System

Beacon provides both real-time push notifications via SSE and email alerts for critical events.

```mermaid
graph LR
    subgraph "Triggers"
        T1["Task Assigned"]
        T2["Task Status Changed"]
        T3["Task Commented"]
        T4["Task Due Soon (cron)"]
        T5["Task Overdue (cron)"]
        T6["Sprint Started/Completed"]
        T7["Member Joined/Removed"]
        T8["Mention in Comment"]
    end

    subgraph "Notification Service"
        NS["NotificationsService<br/>createAndEmit()"]
    end

    subgraph "Delivery"
        DB["Database<br/>(persist notification)"]
        SSE["SSE Stream<br/>/api/notifications/stream"]
        Email["Resend Email<br/>(for assignees)"]
    end

    T1 & T2 & T3 & T4 & T5 & T6 & T7 & T8 --> NS
    NS --> DB
    NS --> SSE
    NS --> Email
```

---

## Project Structure

```
beaconix/
├── .github/
│   ├── workflows/
│   │   └── ci.yml                      # GitHub Actions CI pipeline
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.md
│   │   └── feature_request.md
│   └── PULL_REQUEST_TEMPLATE.md
├── assets/images/                       # Logos and ERD diagram
├── prisma/
│   ├── schema.prisma                    # Database schema (35 models, 27 enums)
│   └── migrations/                      # Prisma migration history
├── probes/
│   └── agent/                           # Probe agent CLI (zero deps) + SCF entry
├── scripts/
│   └── test-resend.ts                   # Resend integration test script
├── src/
│   ├── main.ts                          # Application bootstrap
│   ├── app.module.ts                    # Root module
│   ├── app.controller.ts               # Health check endpoint
│   ├── app.service.ts
│   ├── common/
│   │   ├── decorators/
│   │   │   ├── audit-log.decorator.ts   # @AuditLog() decorator
│   │   │   ├── current-user.decorator.ts# @CurrentUser() param decorator
│   │   │   ├── org-id.decorator.ts      # @OrgId() param decorator
│   │   │   ├── public.decorator.ts      # @Public() route decorator
│   │   │   └── roles.decorator.ts       # @Roles() route decorator
│   │   ├── filters/
│   │   │   └── global-exception.filter.ts  # Structured error responses
│   │   ├── guards/
│   │   │   ├── jwt-auth.guard.ts        # JWT Bearer token verification
│   │   │   ├── org-member.guard.ts      # Organization membership check
│   │   │   └── roles.guard.ts           # Role hierarchy enforcement
│   │   ├── interceptors/
│   │   │   ├── audit-log.interceptor.ts # Before/after snapshot audit logging
│   │   │   └── transform.interceptor.ts # Response wrapping { data, meta }
│   │   ├── interfaces/
│   │   │   └── jwt-payload.interface.ts # JWT token payload type
│   │   └── utils/
│   │       └── otp.util.ts             # OTP generation and HTML escaping
│   ├── config/
│   │   ├── app.config.ts               # App name, port, CORS, environment
│   │   ├── database.config.ts          # DATABASE_URL
│   │   ├── jwt.config.ts               # JWT secrets and expiration
│   │   ├── resend.config.ts            # Resend API key, from address
│   │   ├── throttler.config.ts         # Rate limiter TTL and limit
│   │   └── env.ts                      # requireEnv / optionalEnv helpers
│   ├── infra/
│   │   ├── cache/                      # In-process cache helpers
│   │   ├── cls/                        # Request ID / CLS context
│   │   ├── database/                   # Global Prisma module + pg adapter
│   │   ├── logging/                    # Pino structured logging
│   │   ├── queue/                      # BullMQ queue configuration
│   │   ├── redis/                      # Redis connection service
│   │   ├── scheduler/                  # Redis/BullMQ scheduled jobs
│   │   └── wechat/                     # WeChat clients: pay, mini, web, OA, work
│   ├── generated/prisma/               # Auto-generated Prisma client
│   ├── shared/
│   │   ├── quota/                      # Plan/quota enforcement
│   │   └── subscription/               # Effective subscription lookup
│   └── modules/
│       ├── admin/                       # SUPER_ADMIN tenant, metrics, system probe admin
│       ├── auth/                        # Registration, login, JWT, OTP, profile
│       │   └── wechat/                  # Web, mini-program, and scan-login auth
│       ├── organizations/               # Org CRUD, ownership transfer
│       ├── memberships/                 # Member listing, role changes, removal
│       ├── invitations/                 # Invite send, accept, decline, revoke
│       ├── projects/                    # Project CRUD, archive, restore
│       ├── sprints/                     # Sprint CRUD, start, complete
│       ├── tasks/                       # Task CRUD, assign, move, watch, dependencies
│       ├── comments/                    # Threaded comments CRUD
│       ├── attachments/                 # Local/OSS uploads, metadata, download/delete
│       ├── labels/                      # Org/project labels, task tagging
│       ├── notifications/               # SSE stream, read/unread, CRUD
│       ├── audit-logs/                  # Immutable audit log queries
│       ├── monitors/                    # HTTP/TCP monitor CRUD, pause/resume/restore
│       ├── checker/                     # HTTP/TCP checks and check history
│       ├── state/                       # Monitor state read model
│       ├── monitoring/                  # Org/project monitoring overview
│       ├── probes/                      # Tenant probes, ingest, validation, results
│       ├── notifier/                    # Alert channels and notification delivery queue
│       ├── status-pages/                # Tenant status pages and public status endpoint
│       ├── billing/                     # Plans, subscriptions, orders, payment
│       ├── developer-api/               # API keys, PATs, scoped /developer/v1 API
│       ├── cron/                        # Scheduled background jobs
│       │   └── jobs/
│       │       ├── invitation-expiry.service.ts
│       │       ├── task-due-soon.service.ts
│       │       ├── task-overdue.service.ts
│       │       ├── token-cleanup.service.ts
│       │       └── monitor-data-cleanup.service.ts
│       ├── email/                       # Resend email service + templates
│       └── users/                       # User lookup service
├── test/
│   └── jest-e2e.json                    # E2E test configuration
├── docker-compose.yml                   # Local PostgreSQL service
├── Dockerfile                           # Multi-stage production build
├── nest-cli.json
├── tsconfig.json
├── tsconfig.build.json
├── eslint.config.mjs
├── prisma.config.ts
├── package.json
└── pnpm-workspace.yaml
```

Each feature module follows a consistent structure:

```
modules/<feature>/
├── <feature>.controller.ts     # Route definitions, Swagger decorators, guards
├── <feature>.module.ts         # NestJS module declaration
├── <feature>.service.ts        # Business logic, Prisma queries
├── dto/                        # Request validation DTOs (class-validator)
│   ├── create-<feature>.dto.ts
│   └── update-<feature>.dto.ts
└── entities/                   # Response shape definitions (Swagger)
    └── <feature>.entity.ts
```

### Added Module Map

| Module | Responsibility |
|---|---|
| `monitors` | Tenant monitor configuration for HTTP/TCP targets, including pause, resume, soft delete, and restore |
| `checker` | Manual and scheduled check execution, HTTP/TCP checker implementations, and check history |
| `state` | Current monitor state, failure counters, latency/error snapshots, and SSL metadata |
| `monitoring` | Aggregated organization/project monitoring overview endpoints |
| `probes` | Tenant probe management, probe heartbeat/result ingestion, probe validation challenges, and probe execution logs |
| `notifier` | Notification channel configuration, channel tests, delivery logs, and async alert sending |
| `status-pages` | Tenant-managed public status pages backed by selected monitors |
| `billing` | Plan catalog, quota summary, subscription stack, orders, payment creation, and WeChat Pay callback handling |
| `developer-api` | Organization API keys, user personal access tokens, scoped `/developer/v1` monitor/probe/status-page APIs |
| `admin` | SUPER_ADMIN tenant operations, metrics, audit-log queries, and system-probe management |
| `auth/wechat` | WeChat web login, mini-program login, mini-program QR code, and scan-login polling |
| `infra/wechat` | Low-level clients for WeChat Pay, mini-program, web login, official account, and work WeChat |
| `infra/scheduler` | BullMQ-backed recurring jobs that replace replica-local `@Cron` timers |
| `shared/quota` | Shared quota enforcement for monitoring/billing limits |

---

## API Reference

All endpoints are prefixed with `/api`. Protected endpoints require a `Bearer` token in the `Authorization` header.

### Auth Endpoints

| Method | Endpoint | Description | Auth |
|---|---|---|---|
| `POST` | `/api/auth/register` | Create a new user account | Public |
| `POST` | `/api/auth/verify-email` | Verify email with OTP code | Public |
| `POST` | `/api/auth/resend-verification` | Resend email verification OTP | Public |
| `POST` | `/api/auth/forgot-password` | Request password reset OTP | Public |
| `POST` | `/api/auth/reset-password` | Reset password using OTP | Public |
| `POST` | `/api/auth/login` | Login with email and password | Public |
| `POST` | `/api/auth/refresh` | Rotate refresh token and get new tokens | Public |
| `POST` | `/api/auth/logout` | Revoke refresh token | JWT |
| `GET` | `/api/auth/me` | Get current user profile | JWT |
| `PATCH` | `/api/auth/me` | Update current user profile | JWT |
| `PATCH` | `/api/auth/me/password` | Change password | JWT |

### Organizations Endpoints

| Method | Endpoint | Description | Min Role |
|---|---|---|---|
| `POST` | `/api/organizations` | Create a new organization | JWT |
| `GET` | `/api/organizations` | List current user's organizations | JWT |
| `GET` | `/api/organizations/:id` | Get organization by ID | MEMBER |
| `PATCH` | `/api/organizations/:id` | Update organization | ADMIN |
| `DELETE` | `/api/organizations/:id` | Soft delete organization | OWNER |
| `PATCH` | `/api/organizations/:id/transfer` | Transfer ownership | OWNER |

### Memberships Endpoints

| Method | Endpoint | Description | Min Role |
|---|---|---|---|
| `GET` | `/api/organizations/:orgId/members` | List organization members | MEMBER |
| `PATCH` | `/api/organizations/:orgId/members/:userId` | Change a member's role | ADMIN |
| `DELETE` | `/api/organizations/:orgId/members/:userId` | Remove a member | ADMIN |
| `DELETE` | `/api/organizations/:orgId/members/me` | Leave the organization | MEMBER |

### Invitations Endpoints

| Method | Endpoint | Description | Min Role |
|---|---|---|---|
| `POST` | `/api/organizations/:orgId/invitations` | Send an invitation | ADMIN |
| `GET` | `/api/organizations/:orgId/invitations` | List organization invitations | ADMIN |
| `DELETE` | `/api/organizations/:orgId/invitations/:id` | Revoke a pending invitation | ADMIN |
| `GET` | `/api/invitations/:token` | Get invitation info by token | Public |
| `POST` | `/api/invitations/:token/accept` | Accept an invitation | JWT |
| `POST` | `/api/invitations/:token/decline` | Decline an invitation | JWT |

### Projects Endpoints

| Method | Endpoint | Description | Min Role |
|---|---|---|---|
| `GET` | `/api/organizations/:orgId/projects` | List all projects | MEMBER |
| `POST` | `/api/organizations/:orgId/projects` | Create a new project | ADMIN |
| `GET` | `/api/organizations/:orgId/projects/:id` | Get project by ID | MEMBER |
| `PATCH` | `/api/organizations/:orgId/projects/:id` | Update project | ADMIN |
| `POST` | `/api/organizations/:orgId/projects/:id/archive` | Archive project | ADMIN |
| `DELETE` | `/api/organizations/:orgId/projects/:id` | Soft delete project | ADMIN |
| `POST` | `/api/organizations/:orgId/projects/:id/restore` | Restore soft-deleted project | ADMIN |

### Sprints Endpoints

| Method | Endpoint | Description | Min Role |
|---|---|---|---|
| `GET` | `/api/projects/:projectId/sprints` | List all sprints in a project | MEMBER |
| `POST` | `/api/projects/:projectId/sprints` | Create a new sprint | ADMIN |
| `GET` | `/api/projects/:projectId/sprints/:id` | Get sprint by ID | MEMBER |
| `PATCH` | `/api/projects/:projectId/sprints/:id` | Update sprint details | ADMIN |
| `POST` | `/api/projects/:projectId/sprints/:id/start` | Start a sprint | ADMIN |
| `POST` | `/api/projects/:projectId/sprints/:id/complete` | Complete a sprint | ADMIN |
| `DELETE` | `/api/projects/:projectId/sprints/:id` | Delete a sprint | ADMIN |

### Tasks Endpoints

| Method | Endpoint | Description | Min Role |
|---|---|---|---|
| `POST` | `/api/projects/:projectId/tasks` | Create a new task | MEMBER |
| `GET` | `/api/projects/:projectId/tasks` | List tasks with filters and pagination | MEMBER |
| `GET` | `/api/projects/:projectId/tasks/backlog` | Get backlog tasks (no sprint) | MEMBER |
| `GET` | `/api/projects/:projectId/tasks/:taskId` | Get task details | MEMBER |
| `PATCH` | `/api/projects/:projectId/tasks/:taskId` | Update a task | MEMBER |
| `DELETE` | `/api/projects/:projectId/tasks/:taskId` | Soft-delete a task | MEMBER |
| `PATCH` | `/api/projects/:projectId/tasks/:taskId/restore` | Restore a soft-deleted task | ADMIN |
| `PATCH` | `/api/projects/:projectId/tasks/:taskId/assign` | Assign or unassign a task | MEMBER |
| `PATCH` | `/api/projects/:projectId/tasks/:taskId/move` | Move task to sprint or backlog | MEMBER |
| `POST` | `/api/projects/:projectId/tasks/:taskId/watch` | Watch a task | MEMBER |
| `DELETE` | `/api/projects/:projectId/tasks/:taskId/watch` | Unwatch a task | MEMBER |
| `POST` | `/api/projects/:projectId/tasks/:taskId/dependencies` | Add a dependency | MEMBER |
| `DELETE` | `/api/projects/:projectId/tasks/:taskId/dependencies/:depId` | Remove a dependency | MEMBER |
| `GET` | `/api/projects/:projectId/tasks/:taskId/activities` | Get task activity log | MEMBER |

### Comments Endpoints

| Method | Endpoint | Description | Min Role |
|---|---|---|---|
| `GET` | `/api/tasks/:taskId/comments` | List threaded comments for a task | MEMBER |
| `POST` | `/api/tasks/:taskId/comments` | Add a comment to a task | MEMBER |
| `PATCH` | `/api/tasks/:taskId/comments/:id` | Edit a comment (author only) | MEMBER |
| `DELETE` | `/api/tasks/:taskId/comments/:id` | Soft-delete a comment (author or Admin) | MEMBER |

### Attachments Endpoints

| Method | Endpoint | Description | Min Role |
|---|---|---|---|
| `POST` | `/api/attachments/upload` | Upload a file without creating task attachment metadata | Authenticated |
| `GET` | `/api/attachments/object?key=...` | Preview or download a general uploaded object | Authenticated |
| `GET` | `/api/tasks/:taskId/attachments` | List attachments for a task | MEMBER |
| `POST` | `/api/tasks/:taskId/attachments/upload` | Upload a file and save metadata | MEMBER |
| `POST` | `/api/tasks/:taskId/attachments` | Save attachment metadata | MEMBER |
| `GET` | `/api/tasks/:taskId/attachments/:id/download` | Download or redirect to an attachment object | MEMBER |
| `DELETE` | `/api/tasks/:taskId/attachments/:id` | Remove an attachment | MEMBER |

General uploads accept multipart fields `file` and optional `directory`. Empty `directory` stores objects under `uploads/yyyy/mm/`; a provided directory is sanitized and stored under `<directory>/yyyy/mm/`, relative to `STORAGE_PUBLIC_ROOT` (default `storage/public`). Files uploaded with `directory=tickets` are the exception: they land in the private root (`storage/private/tickets/yyyy/mm/`) and are only readable through a signed link or as a signed-in participant. Task attachments and ticket files must still use their download APIs. The app serves the public root itself at `/storage/public/<key>`, so a public upload comes back as `<storage.publicBaseUrl>/storage/public/<key>` (relative `/storage/public/<key>` when that setting is empty).

### Labels Endpoints

| Method | Endpoint | Description | Min Role |
|---|---|---|---|
| `GET` | `/api/organizations/:orgId/labels` | List org-wide labels | MEMBER |
| `POST` | `/api/organizations/:orgId/labels` | Create an org-wide label | ADMIN |
| `GET` | `/api/projects/:projectId/labels` | List project-scoped labels | MEMBER |
| `POST` | `/api/projects/:projectId/labels` | Create a project-scoped label | ADMIN |
| `PATCH` | `/api/labels/:id` | Update a label | ADMIN |
| `DELETE` | `/api/labels/:id` | Delete a label | ADMIN |
| `POST` | `/api/tasks/:taskId/labels/:labelId` | Tag a task with a label | MEMBER |
| `DELETE` | `/api/tasks/:taskId/labels/:labelId` | Remove a label from a task | MEMBER |

### Notifications Endpoints

| Method | Endpoint | Description | Auth |
|---|---|---|---|
| `GET` | `/api/notifications` | List notifications (paginated) | JWT |
| `GET` | `/api/notifications/unread-count` | Get unread notification count | JWT |
| `GET` | `/api/notifications/stream` | Subscribe to real-time SSE stream | JWT |
| `PATCH` | `/api/notifications/read-all` | Mark all notifications as read | JWT |
| `PATCH` | `/api/notifications/:id/read` | Mark a single notification as read | JWT |
| `DELETE` | `/api/notifications/:id` | Delete a notification | JWT |

### Audit Logs Endpoints

| Method | Endpoint | Description | Min Role |
|---|---|---|---|
| `GET` | `/api/organizations/:orgId/audit-logs` | List audit logs for an organization | ADMIN |

### Monitoring Endpoints

| Method | Endpoint | Description | Min Role |
|---|---|---|---|
| `GET` | `/api/projects/:projectId/monitors` | List monitors in a project | MEMBER |
| `POST` | `/api/projects/:projectId/monitors` | Create an HTTP/TCP monitor | MEMBER |
| `GET` | `/api/projects/:projectId/monitors/:id` | Get monitor details | MEMBER |
| `PATCH` | `/api/projects/:projectId/monitors/:id` | Update monitor configuration | MEMBER |
| `POST` | `/api/projects/:projectId/monitors/:id/pause` | Pause monitor checks | MEMBER |
| `POST` | `/api/projects/:projectId/monitors/:id/resume` | Resume monitor checks | MEMBER |
| `DELETE` | `/api/projects/:projectId/monitors/:id` | Soft-delete a monitor | MEMBER |
| `POST` | `/api/projects/:projectId/monitors/:id/restore` | Restore a soft-deleted monitor | MEMBER |
| `POST` | `/api/projects/:projectId/monitors/:monitorId/check` | Run a manual check | MEMBER |
| `GET` | `/api/projects/:projectId/monitors/:monitorId/checks` | List check history | MEMBER |
| `GET` | `/api/projects/:projectId/monitors/:monitorId/state` | Get current monitor state | MEMBER |
| `GET` | `/api/organizations/:orgId/monitoring/overview` | Organization monitoring overview | MEMBER |
| `GET` | `/api/projects/:projectId/monitoring/overview` | Project monitoring overview | MEMBER |

### Probes Endpoints

| Method | Endpoint | Description | Auth |
|---|---|---|---|
| `GET` | `/api/organizations/:orgId/probes` | List tenant probes | MEMBER |
| `POST` | `/api/organizations/:orgId/probes` | Create tenant probe and return secret once | MEMBER |
| `GET` | `/api/organizations/:orgId/probes/:id` | Get probe details | MEMBER |
| `PATCH` | `/api/organizations/:orgId/probes/:id` | Update probe metadata/configuration | MEMBER |
| `DELETE` | `/api/organizations/:orgId/probes/:id` | Delete a probe | MEMBER |
| `POST` | `/api/organizations/:orgId/probes/:id/rotate-secret` | Rotate probe secret | MEMBER |
| `POST` | `/api/organizations/:orgId/probes/:id/validate` | Trigger manual validation challenge | MEMBER |
| `POST` | `/api/organizations/:orgId/probes/:id/monitors` | Bind monitors to a probe | MEMBER |
| `DELETE` | `/api/organizations/:orgId/probes/:id/monitors/:monitorId` | Unbind monitor from probe | MEMBER |
| `GET` | `/api/organizations/:orgId/probes/:id/results` | List probe result history | MEMBER |
| `GET` | `/api/organizations/:orgId/probes/:id/executions` | List probe execution logs | MEMBER |
| `POST` | `/api/probes/heartbeat` | Probe agent heartbeat and assignment pull | Probe secret |
| `POST` | `/api/probes/results` | Probe agent batch result report | Probe secret |
| `POST` | `/api/probes/validation/pull` | Probe agent pulls pending validation challenge | Probe secret |
| `POST` | `/api/probes/validation/:validationId/answer` | Probe agent answers validation challenge | Probe secret |

### Status Pages Endpoints

| Method | Endpoint | Description | Auth |
|---|---|---|---|
| `GET` | `/api/organizations/:orgId/status-pages` | List status pages | MEMBER |
| `POST` | `/api/organizations/:orgId/status-pages` | Create status page | MEMBER |
| `GET` | `/api/organizations/:orgId/status-pages/:id` | Get status page config | MEMBER |
| `PATCH` | `/api/organizations/:orgId/status-pages/:id` | Update status page config | MEMBER |
| `DELETE` | `/api/organizations/:orgId/status-pages/:id` | Delete status page | MEMBER |
| `GET` | `/api/status/:slug` | Public status page payload | Public |

### Notification Channels Endpoints

| Method | Endpoint | Description | Min Role |
|---|---|---|---|
| `GET` | `/api/organizations/:orgId/notification-channels` | List alert channels | MEMBER |
| `POST` | `/api/organizations/:orgId/notification-channels` | Create alert channel | MEMBER |
| `GET` | `/api/organizations/:orgId/notification-channels/:id` | Get alert channel | MEMBER |
| `PATCH` | `/api/organizations/:orgId/notification-channels/:id` | Update alert channel | MEMBER |
| `DELETE` | `/api/organizations/:orgId/notification-channels/:id` | Delete alert channel | MEMBER |
| `POST` | `/api/organizations/:orgId/notification-channels/:id/test` | Send channel test notification | MEMBER |
| `GET` | `/api/organizations/:orgId/notification-channels/:id/logs` | List channel delivery logs | MEMBER |

### Developer Access Endpoints

| Method | Endpoint | Description | Auth |
|---|---|---|---|
| `POST` | `/api/organizations/:orgId/api-keys` | Create organization API key | JWT |
| `GET` | `/api/organizations/:orgId/api-keys` | List organization API keys | JWT |
| `POST` | `/api/organizations/:orgId/api-keys/:id/revoke` | Revoke organization API key | JWT |
| `POST` | `/api/users/me/personal-access-tokens` | Create user personal access token | JWT |
| `GET` | `/api/users/me/personal-access-tokens` | List personal access tokens | JWT |
| `POST` | `/api/users/me/personal-access-tokens/:id/revoke` | Revoke personal access token | JWT |
| `GET` | `/api/developer/v1/organizations/:orgId/overview` | Developer API organization overview | API key / PAT |
| `GET` | `/api/developer/v1/organizations/:orgId/monitors` | Developer API organization monitors | API key / PAT |
| `GET` | `/api/developer/v1/projects/:projectId/monitors` | Developer API project monitors | API key / PAT |
| `POST` | `/api/developer/v1/projects/:projectId/monitors` | Developer API create monitor | API key / PAT |
| `PATCH` | `/api/developer/v1/projects/:projectId/monitors/:id` | Developer API update monitor | API key / PAT |
| `DELETE` | `/api/developer/v1/projects/:projectId/monitors/:id` | Developer API delete monitor | API key / PAT |
| `GET` | `/api/developer/v1/organizations/:orgId/probes` | Developer API probes | API key / PAT |
| `GET` | `/api/developer/v1/organizations/:orgId/status-pages` | Developer API status pages | API key / PAT |

### Billing Endpoints

| Method | Endpoint | Description | Auth |
|---|---|---|---|
| `GET` | `/api/plans` | List enabled plans | Public/JWT |
| `GET` | `/api/plans/:id` | Get plan details | Public/JWT |
| `GET` | `/api/organizations/:orgId/subscription` | Get effective subscription stack | JWT |
| `GET` | `/api/organizations/:orgId/quota` | Get quota usage and limits | JWT |
| `POST` | `/api/organizations/:orgId/orders` | Create plan order | JWT |
| `GET` | `/api/organizations/:orgId/orders` | List organization orders | JWT |
| `GET` | `/api/orders/:id` | Get order details | JWT |
| `POST` | `/api/orders/:id/cancel` | Cancel pending order | JWT |
| `POST` | `/api/orders/:id/pay` | Create payment payload | JWT |
| `POST` | `/api/payment/wechat/callback` | WeChat Pay callback | WeChat Pay |

### Admin Endpoints

| Method | Endpoint | Description | Auth |
|---|---|---|---|
| `GET` | `/api/admin/tenants` | List tenants | SUPER_ADMIN |
| `GET` | `/api/admin/tenants/:id` | Get tenant detail | SUPER_ADMIN |
| `PATCH` | `/api/admin/tenants/:id/toggle` | Enable/disable tenant | SUPER_ADMIN |
| `GET` | `/api/admin/metrics/overview` | System metrics overview | SUPER_ADMIN |
| `GET` | `/api/admin/metrics/scheduler` | Scheduler metrics | SUPER_ADMIN |
| `GET` | `/api/admin/metrics/tenants` | Tenant metrics | SUPER_ADMIN |
| `GET` | `/api/admin/audit-logs` | Cross-tenant audit-log query | SUPER_ADMIN |
| `POST` | `/api/admin/system-probes` | Create system probe | SUPER_ADMIN |
| `GET` | `/api/admin/system-probes` | List system probes | SUPER_ADMIN |
| `GET` | `/api/admin/system-probes/:id` | Get system probe | SUPER_ADMIN |
| `PATCH` | `/api/admin/system-probes/:id` | Update system probe | SUPER_ADMIN |
| `PATCH` | `/api/admin/system-probes/:id/toggle` | Enable/disable system probe | SUPER_ADMIN |
| `DELETE` | `/api/admin/system-probes/:id` | Delete system probe | SUPER_ADMIN |
| `POST` | `/api/admin/system-probes/:id/validate` | Validate system probe | SUPER_ADMIN |
| `POST` | `/api/admin/system-probes/rebalance` | Rebalance system probe assignments | SUPER_ADMIN |

### WeChat Auth Endpoints

| Method | Endpoint | Description | Auth |
|---|---|---|---|
| `GET` | `/api/auth/wechat/web/authorize-url` | Build WeChat web authorize URL | Public |
| `POST` | `/api/auth/wechat/web/login` | Login with WeChat web authorization code | Public |
| `POST` | `/api/auth/wechat/miniprogram/login` | Login with mini-program code | Public |
| `POST` | `/api/auth/wechat/miniprogram/qrcode` | Create mini-program scan-login QR code | Public |
| `POST` | `/api/auth/wechat/miniprogram/scan-login` | Confirm scan login from mini-program | Public |
| `GET` | `/api/auth/wechat/miniprogram/qrcode/status` | Poll scan-login status | Public |

---

## Database Schema

The original Agile workspace schema contains the core models below. The current codebase has grown to **35 models** and **27 enums** with additional monitoring, probe, notification-channel, status-page, developer-credential, and billing tables.

**Models:** User, OtpCode, RefreshToken, Organization, Membership, Invitation, Project, Sprint, Task, TaskDependency, TaskWatcher, TaskActivity, Comment, Attachment, Label, TaskLabel, Notification, AuditLog

**Additional model groups:** Monitor, MonitorState, Probe, MonitorProbe, ProbeResult, ProbeExecution, CheckLog, NotificationChannel, NotificationLog, StatusPage, ApiKey, PersonalAccessToken, Plan, Subscription, Order, Payment, UserIdentity.

**Enums:**

| Enum | Values |
|---|---|
| `GlobalRole` | SUPER_ADMIN, USER |
| `MembershipRole` | OWNER, ADMIN, MEMBER, VIEWER |
| `ProjectStatus` | ACTIVE, ARCHIVED |
| `SprintStatus` | PLANNED, ACTIVE, COMPLETED |
| `TaskPriority` | LOW, MEDIUM, HIGH, CRITICAL |
| `TaskStatus` | TODO, IN_PROGRESS, IN_REVIEW, DONE, CANCELLED |
| `InvitationStatus` | PENDING, ACCEPTED, DECLINED, EXPIRED, REVOKED |
| `NotificationType` | TASK_ASSIGNED, TASK_UPDATED, TASK_COMMENTED, TASK_STATUS_CHANGED, TASK_DUE_SOON, TASK_OVERDUE, SPRINT_STARTED, SPRINT_COMPLETED, PROJECT_ARCHIVED, MEMBER_JOINED, MEMBER_REMOVED, MENTION |
| `AuditAction` | CREATE, UPDATE, DELETE, RESTORE, ARCHIVE, INVITE, JOIN, LEAVE, ASSIGN, UNASSIGN |
| `AttachmentSource` | UPLOAD, GOOGLE_DRIVE, DROPBOX, URL |
| `CommentType` | TEXT, SYSTEM |
| `OtpPurpose` | EMAIL_VERIFICATION, PASSWORD_RESET |

Key design decisions:
- **Soft deletes** on User, Organization, Project, Task, and Comment via `deletedAt` timestamps
- **Composite unique constraints** for multi-tenant isolation (e.g., `[userId, organizationId]` on Membership)
- **Auto-incrementing task numbers** per project for human-readable identifiers like `PROJ-42`
- **Self-referencing relations** for subtasks (Task) and threaded replies (Comment)
- **JSON fields** for flexible org settings and audit log metadata
- **Comprehensive indexing** on foreign keys, status fields, and frequently queried columns

---

## Cron Jobs

Recurring background jobs run through BullMQ scheduled jobs on Redis, so only one worker handles each scheduled run even when multiple API replicas are running:

| Job | Schedule | Purpose |
|---|---|---|
| **Invitation Expiry** | Every hour | Marks `PENDING` invitations as `EXPIRED` when `expiresAt` has passed |
| **Task Due Soon** | Every 6 hours | Notifies watchers (SSE) and emails assignees about tasks due within 24 hours |
| **Task Overdue** | Daily at 8:00 AM | Notifies watchers (SSE) and emails assignees about past-due tasks |
| **Token Cleanup** | Daily at 2:00 AM | Deletes expired and revoked refresh tokens from the database |
| **Monitor Data Cleanup** | Daily at 3:00 AM | Prunes old monitoring/check data |
| **Order Expiry Sweep** | Every 5 minutes | Cancels expired pending orders |
| **Subscription Expiry Sweep** | Every hour | Marks expired subscriptions |
| **System Probe Assignment Refresh** | Every hour | Refreshes system probe tenant assignments |
| **Probe Offline Sweep** | Every minute | Marks probes offline after missed heartbeat threshold |

---

## Email Templates

Beacon sends transactional emails via [Resend](https://resend.com) with branded HTML templates:

| Template | Trigger | Recipient |
|---|---|---|
| **Email Verification** | User registration | New user |
| **Password Reset OTP** | Forgot password request | User |
| **Invitation** | Admin invites a user to an organization | Invitee |
| **Welcome** | User accepts an invitation | New member |
| **Task Assigned** | Task is assigned to a user | Assignee |
| **Task Due Soon** | Cron detects task due within 24h | Assignee |
| **Task Overdue** | Cron detects past-due task | Assignee |
| **Password Reset** | Legacy reset link (URL-based) | User |

All templates use a consistent layout with the Beacon branding header, responsive design, and XSS-safe HTML escaping.

In development (`NODE_ENV=development`) `EmailService` runs in dev mode: nothing is sent through Resend, the recipient, subject, payload and rendered HTML are printed to the application console instead. Use a non-development `NODE_ENV` with `RESEND_API_KEY` configured to send real email, or run `pnpm test:resend` to verify delivery with the standalone script.

---

## Security

Beacon implements multiple layers of security:

| Mechanism | Implementation |
|---|---|
| **Authentication** | JWT access tokens (15min) + rotating refresh tokens (7d) with bcrypt-hashed storage |
| **Password Hashing** | bcrypt with automatic salt generation |
| **OTP Codes** | bcrypt-hashed, time-limited, attempt-tracked one-time passwords |
| **HTTP Security** | Helmet middleware for security headers (CSP, HSTS, X-Frame-Options, etc.) |
| **CORS** | Configurable origin allowlist |
| **Rate Limiting** | Global throttle guard (default: 10 requests per 60 seconds), stricter limits on auth endpoints |
| **Input Validation** | Whitelist-only DTO validation via `class-validator` with `forbidNonWhitelisted` |
| **SQL Injection** | Prevented by Prisma's parameterized queries |
| **XSS Prevention** | HTML escaping on all email template dynamic content |
| **Soft Deletes** | Data recovery without permanent loss |
| **Audit Trail** | Immutable audit logs with before/after snapshots, IP address, and user agent |
| **Sensitive Data** | Password, token, and refreshToken fields are redacted from audit log snapshots |
| **Token Revocation** | Refresh tokens can be revoked on logout; all tokens revoked on password reset |
| **Email Verification** | Required before login is allowed |

---

## Development and Deployment Workflow

Beacon follows a structured development workflow from local development through CI checks to production deployment.

### Git Branching Strategy

```mermaid
gitGraph
    commit id: "initial"
    branch feat/task-dependencies
    commit id: "add dependency model"
    commit id: "add dependency endpoints"
    checkout master
    merge feat/task-dependencies id: "PR #12 merged" tag: "squash"
    branch fix/token-expiry
    commit id: "fix refresh token edge case"
    checkout master
    merge fix/token-expiry id: "PR #13 merged" tag: "squash"
```

**Branch naming conventions:**

| Prefix | Usage |
|---|---|
| `feat/` | New feature |
| `fix/` | Bug fix |
| `chore/` | Maintenance, dependencies, config |
| `docs/` | Documentation only |
| `refactor/` | Code restructuring |
| `test/` | Adding or updating tests |

**Branch protection rules on `master`:**
- Pull request required (no direct pushes)
- Status checks must pass (CI pipeline)
- Squash merge enforced

### Pre-Commit Hooks

Husky runs automated checks before every commit:

```mermaid
graph LR
    GC["git commit"] --> H["Husky Pre-Commit Hook"]
    H --> TC["TypeScript Type Check<br/>pnpm type-check"]
    TC -->|pass| FMT["Code Formatting Check<br/>pnpm format --check"]
    FMT -->|pass| LINT["ESLint<br/>pnpm lint"]
    LINT -->|pass| OK["Commit Accepted"]

    TC -->|fail| BLOCK["Commit Blocked"]
    FMT -->|fail| BLOCK
    LINT -->|fail| BLOCK
```

### Dependabot

Dependabot keeps dependencies and GitHub Actions versions current with scheduled update PRs and security alerts.

Current configuration in `.github/dependabot.yml`:

| Ecosystem | Scope | Schedule | Notes |
|---|---|---|---|
| `npm` | Root workspace (`/`) | Weekly (Monday, 04:00 UTC) | Target branch: `master`; auto-rebase; labels (`dependencies`, `security`); commit prefix `chore(deps)` with scope; grouped updates for `@nestjs/*`, `prisma`, `@prisma/*` |
| `github-actions` | Repository workflows | Monthly (Monday, 05:00 UTC) | Target branch: `master`; auto-rebase; labels (`dependencies`, `github-actions`); commit prefix `chore(ci)` with scope |

**Branch strategy:**
- Dependabot PRs target `master` directly.
- Updates are merged like any other PR, after CI passes.

**PR conventions:**
- Dependabot rebases update PRs automatically when needed.
- Commit messages follow conventional prefixes for cleaner history and release notes.

**How Beacon handles transitive security advisories:**
- If Dependabot cannot auto-open a fix PR for a transitive package, we pin a patched transitive version using `pnpm.overrides` in `package.json`.
- After updating overrides, regenerate and commit `pnpm-lock.yaml` so GitHub dependency scanning can resolve the fixed version.
- Remove temporary overrides once upstream packages adopt patched versions.

### CI Pipeline

GitHub Actions runs on every push to `master` and on pull requests targeting `master`:

```mermaid
graph TD
    PR["Pull Request / Push to master"] --> CI["GitHub Actions CI"]

    CI --> CHECKOUT["Checkout Code"]
    CHECKOUT --> NODE["Setup Node.js 22"]
    NODE --> PNPM["Install pnpm"]
    PNPM --> CACHE["Cache pnpm dependencies"]
    CACHE --> INSTALL["pnpm install --frozen-lockfile"]
    INSTALL --> GENERATE["prisma generate"]
    GENERATE --> TYPECHECK["TypeScript type check"]
    TYPECHECK --> LINT["ESLint"]
    LINT --> BUILD["Build"]
    BUILD -->|all pass| STATUS["Status Check: Pass"]
    BUILD -->|any fail| FAIL["Status Check: Fail"]

    STATUS --> MERGE["PR can be merged"]
    FAIL --> BLOCKED["PR merge blocked"]
```

### Deployment Pipeline

```mermaid
graph TD
    DEV["Developer pushes to feature branch"]
    DEV --> PR["Opens PR to master"]
    PR --> CI["CI Pipeline Runs<br/>(type-check, lint, build)"]
    CI -->|pass| REVIEW["Code Review"]
    REVIEW --> MERGE["Squash merge to master"]

    MERGE --> CI2["CI Runs on master after merge"]
    CI2 -->|pass| RENDER["Render Deployment<br/>(Manual trigger after CI passes)"]

    subgraph "Render Build"
        RENDER --> DOCKER["Docker Multi-Stage Build"]
        DOCKER --> DEPS["Stage 1: Install dependencies<br/>pnpm install --frozen-lockfile"]
        DEPS --> BUILD["Stage 2: Build<br/>prisma generate + pnpm build"]
        BUILD --> PROD["Stage 3: Production image<br/>Alpine Node.js, minimal footprint"]
        PROD --> MIGRATE["Run prisma migrate deploy"]
        MIGRATE --> START["Start server<br/>node dist/src/main"]
    end
```

**Docker multi-stage build details:**

| Stage | Purpose | Base Image |
|---|---|---|
| **deps** | Install production dependencies | `node:22-alpine` |
| **builder** | Generate Prisma client and compile TypeScript | `node:22-alpine` |
| **runner** | Minimal production image with compiled app | `node:22-alpine` |

The production container includes a health check endpoint (`GET /api`) and exposes port 3000.

---

## Getting Started

### Prerequisites

- **Node.js** >= 22
- **pnpm** (latest)
- **PostgreSQL** 16 (or use Docker)
- **Resend** API key (for email features)
- Local disk storage or S3-compatible OSS credentials (for file uploads)

### Installation

```bash
# Clone the repository
git clone https://github.com/xuzuxing/beaconix.git
cd beaconix

# Install dependencies
pnpm install
```

### Environment Variables

Copy the example environment file and configure it:

```bash
cp .env.example .env
```

| Variable | Required | Description |
|---|---|---|
| `APP_NAME` | No | Application name (default: `beaconix`) |
| `PORT` | No | Server port (default: `3000`) |
| `NODE_ENV` | No | Environment: `development`, `production`, `test` |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `JWT_SECRET` | Yes | Secret key for signing access tokens |
| `JWT_REFRESH_SECRET` | Yes | Secret key for signing refresh tokens |
| `JWT_ACCESS_EXPIRES_IN` | No | Access token TTL (default: `15m`) |
| `JWT_REFRESH_EXPIRES_IN` | No | Refresh token TTL (default: `7d`) |
| `THROTTLE_TTL` | No | Rate limit window in seconds (default: `60`) |
| `THROTTLE_LIMIT` | No | Max requests per window (default: `10`) |
| `STORAGE_PUBLIC_ROOT` | No | Public attachment directory (default: `storage/public`); `STORAGE_LOCAL_ROOT` is accepted as a fallback |
| `STORAGE_PRIVATE_ROOT` | No | Private attachment directory (default: `storage/private`), must not overlap the public root |
| `STORAGE_OSS_ENDPOINT` | Fallback | S3-compatible endpoint; the `storage.oss.endpoint` setting wins when set |
| `STORAGE_OSS_REGION` | Fallback | OSS region (default: `auto`) |
| `STORAGE_OSS_BUCKET` | Fallback | Public attachment bucket; the `storage.oss.bucket` setting wins |
| `STORAGE_OSS_PRIVATE_BUCKET` | Fallback | Private attachment bucket, must differ from the public one |
| `STORAGE_OSS_ACCESS_KEY_ID` | Fallback | OSS access key ID |
| `STORAGE_OSS_ACCESS_KEY_SECRET` | Fallback | OSS access key secret |
| `STORAGE_OSS_FORCE_PATH_STYLE` | Fallback | Use path-style URLs for MinIO/S3-compatible providers |

Every `STORAGE_OSS_*` variable is only a fallback: the OSS connection is configured from the
`storage.oss.*` platform settings (admin UI), which take precedence whenever the row is non-empty.
| `RESEND_API_KEY` | Yes¹ | Resend email service API key |
| `RESEND_FROM_EMAIL` | No | Sender email address |
| `RESEND_FROM_NAME` | No | Sender display name (default: `Beacon`) |
| `CORS_ORIGINS` | No | Comma-separated allowed origins |

¹ Not required when `NODE_ENV=development`, because application emails are printed to stdout instead of sent.

Runtime-tunable platform settings live in the `settings` table and can be managed by SUPER_ADMIN users through `/api/admin/settings`. Built-in defaults are used when a row is absent, and `isDefault` stays `false` once a key has been overridden — including when it is set back to its default value:

| Group | Setting key | Default | Description |
|---|---|---:|---|
| system | `system.siteName` | `Beacon` | Product name in browser titles, emails and status pages |
| system | `system.siteDescription` | 云监控与状态页平台 | Blurb shown on the login and status pages |
| system | `system.logoUrl` | empty | Header/login logo URL; empty falls back to the built-in icon |
| system | `system.faviconUrl` | empty | Browser tab icon URL; empty falls back to the built-in icon |
| system | `system.footerCopyright` | `© 2026 Beacon` | Footer copyright line |
| system | `system.icpLicense` | empty | ICP filing number for deployments in mainland China |
| system | `system.supportEmail` | `support@beacon.example.com` | Contact address shown in the footer and emails |
| system | `system.defaultLocale` | `zh-CN` | Default UI language: `zh-CN` or `en-US` |
| system | `system.maintenanceMode` | `false` | Blocks everyone but platform SUPER_ADMINs |
| smtp | `smtp.host` | empty | SMTP host for system mail; empty means no SMTP is configured |
| smtp | `smtp.port` | `587` | SMTP port: 587 STARTTLS, 465 implicit TLS |
| smtp | `smtp.secure` | `false` | Use implicit TLS; leave off on 587 so STARTTLS is negotiated |
| smtp | `smtp.account` | empty | SMTP login account, usually the full mailbox address |
| smtp | `smtp.password` | empty (secret) | SMTP password or app token; never read back |
| smtp | `smtp.fromAddress` | empty | Envelope sender; falls back to the account, then `RESEND_FROM_EMAIL` |
| develop | `develop.debugMode` | `false` | Adds error details to 5xx responses |
| develop | `develop.apiDocsUrl` | `/reference` | Target of the "API docs" header entry |
| develop | `develop.rateLimitPerMinute` | `120` | Per-account API calls per minute |
| develop | `develop.seedDemoData` | `true` | Seed demo monitors/status pages for new tenants |
| develop | `develop.configGroup` | `["system","develop","storage","attachments"]` | Tab list and order of the platform settings page |
| storage | `storage.driver` | `local` | Active attachment storage driver: `local` or `oss` |
| storage | `storage.oss.endpoint` | empty | OSS/S3-compatible endpoint; falls back to `STORAGE_OSS_ENDPOINT` |
| storage | `storage.oss.region` | `auto` | OSS region; falls back to `STORAGE_OSS_REGION` |
| storage | `storage.oss.bucket` | empty | Public attachment bucket; falls back to `STORAGE_OSS_BUCKET` |
| storage | `storage.oss.privateBucket` | empty | Private attachment bucket, must differ; falls back to `STORAGE_OSS_PRIVATE_BUCKET` |
| storage | `storage.oss.accessKeyId` | empty (secret) | OSS access key ID; falls back to `STORAGE_OSS_ACCESS_KEY_ID` |
| storage | `storage.oss.accessKeySecret` | empty (secret) | OSS access key secret; falls back to `STORAGE_OSS_ACCESS_KEY_SECRET` |
| storage | `storage.oss.forcePathStyle` | `false` | Path-style object URLs for MinIO/S3-compatible providers |
| storage | `storage.publicBaseUrl` | empty | Optional site root (e.g. `https://api.example.com`). Public links are `<siteRoot>/storage/public/<key>`; empty returns the relative `/storage/public/<key>` |
| storage | `storage.oss.publicBaseUrl` | empty | Optional public/CDN base URL for OSS objects |
| storage | `storage.oss.signedUrlTtlSeconds` | `300` | Signed OSS download URL TTL |
| attachments | `attachments.maxImageSizeMb` | `8` | Image upload limit |
| attachments | `attachments.maxPdfSizeMb` | `16` | PDF upload limit |
| attachments | `attachments.maxBlobSizeMb` | `32` | Other allowed file upload limit |
| attachments | `attachments.maxFilesPerRequest` | `5` | Reserved batch upload limit |

`name`, `group`, `valueType`, `description` and `isSecret` all come from the built-in definitions in `src/modules/settings/settings.defaults.ts`, whose array order is also the display order inside each tab. `group` — which decides the tab a setting lands in — is never stored in the database, and the default tab list (`develop.configGroup`) is derived from those groups, so adding a setting or a whole tab is a code change with no migration. `PATCH /api/admin/settings/{key}` only accepts `{ value }`; metadata cannot be edited through the API. Values declared as string arrays (`develop.configGroup`) are validated strictly on write (non-empty, no blanks, no duplicates) and normalized on read. This table holds platform runtime parameters only — per-plan limits such as member or project quotas belong to `billing`.

Built-in rows are inserted by `pnpm prisma:db:seed`. That step is **idempotent and only fills in keys the table does not have yet** — anything already in the table (including values changed from the admin UI) is left untouched, so it is safe to run on every deploy. Run it after a deploy, also on existing databases, otherwise newly added settings simply show up as the code default without a row. `isDefault` means "never overridden" (`settings.overridden = false`, set to `true` by `PATCH`), so a value edited from the UI stops being a default even if it is set back to the built-in value.

`GET /api/settings/public` is the unauthenticated read used on public pages (login, status pages). It returns a flat `{ key: value }` map of the built-in settings marked `isPublic` in `settings.defaults.ts` — currently the nine `system.*` display keys. Internal parameters (`smtp.*`, `storage.*`, `attachments.*`, `develop.*`) and anything flagged `isSecret` are never included, even if a definition is mislabelled. Values come from the same merged/ cached read as the admin endpoint, so a write is visible within 30 seconds.

### Which settings actually change behaviour

Consumed at runtime today:

| Setting | Consumed by |
|---|---|
| `system.siteName` | Email sender display name, and the header/footer of every email template |
| `system.supportEmail` | "Contact" line in the email footer (omitted when empty) |
| `develop.debugMode` | `GlobalExceptionFilter`, which adds `detail` to 5xx responses |
| `system.maintenanceMode` | `MaintenanceGuard` — answers `503` for everyone except platform SUPER_ADMINs and the exempt prefixes |
| `smtp.*` | With `smtp.host` set, system mail is delivered over SMTP instead of Resend |
| `storage.*`, `attachments.max*` | Attachment upload/download path |

The remaining keys are stored, validated and editable, but nothing reads them yet: `system.siteDescription` / `logoUrl` / `faviconUrl` / `footerCopyright` / `icpLicense` / `defaultLocale` and `system.maintenanceMode` are front-end concerns; `develop.apiDocsUrl` / `rateLimitPerMinute` / `seedDemoData` are not wired up.

### Maintenance mode

`system.maintenanceMode` is enforced by `MaintenanceGuard`, registered globally **after** `JwtAuthGuard` (so `request.user` is available). While the switch is on, a request gets `503` with `Retry-After: 60` unless it is:

- a platform `SUPER_ADMIN` (otherwise nobody could turn the switch back off),
- marked with `@SkipMaintenance()`, or
- under one of `MAINTENANCE_EXEMPT_PREFIXES`: `/api/health`, `/api/status`, `/api/auth`, `/api/plans`, `/api/settings/public`, `/api/payment`, `/api/probes`.

Each entry covers the exact segment or anything below it — `/api/status` deliberately does not cover `/api/status-pages`. Those seven are the surfaces that must stay reachable: health probes, sign-in/token refresh, the public status pages, the public settings the web client needs to render the maintenance notice, WeChat Pay callbacks, and probe heartbeats/results.

If the setting cannot be read the guard **fails open** — a settings/DB hiccup must not turn the whole API into 503. The 503 body carries a human-readable `message`, which the web client surfaces as-is.

### When a change takes effect

- Every key is picked up on the next read: `SettingsService` caches each value in-process for 30 seconds and drops the entry when it is written, so the instance that served the `PATCH` sees the new value immediately.
- On a multi-instance deployment the other instances keep serving the cached value for at most 30 seconds.
- `system.siteName` / `system.supportEmail` are resolved per email send, so the next outgoing message picks them up.
- System mail goes through Resend by default. Setting `smtp.host` switches the *next* send to SMTP — `smtp.port` / `smtp.secure` / `smtp.account` / `smtp.password` are read per send and the sender resolves as `smtp.fromAddress` → `smtp.account` → `RESEND_FROM_EMAIL`. Clearing `smtp.host` switches back to Resend. If reading the `smtp.*` values fails, the send falls back to Resend and logs a warning.
- `storage.driver` selects the active upload provider per upload (`StorageService` resolves it on every call) — no restart needed. The OSS endpoint, region, buckets and credentials are read from the `storage.oss.*` settings rows and fall back to the `STORAGE_OSS_*` environment variables when a row is empty, so OSS can be configured — and rotated — entirely from the admin UI. `OssStorageProvider` rebuilds its S3 client on the next call whenever any of those values changes.
- `storage.oss.signedUrlTtlSeconds` is clamped to 300 seconds when a signed download URL is generated.
- `attachments.maxFilesPerRequest` is reserved; the upload path does not consume it yet.

### Running the Application

**Using Docker Compose (recommended for PostgreSQL):**

```bash
# Start PostgreSQL
docker compose up -d

# Set DATABASE_URL in .env:
# DATABASE_URL=postgresql://postgres:postgres@localhost:5433/beaconix
```

**Run database migrations:**

```bash
pnpm prisma:migrate
```

**Start the development server:**

```bash
pnpm start:dev
```

The API will be available at `http://localhost:3000/api`, and the Scalar API reference is available at `http://localhost:3000/reference`.

**Available scripts:**

| Script | Description |
|---|---|
| `pnpm start:dev` | Start in watch mode |
| `pnpm start:debug` | Start in debug + watch mode |
| `pnpm build` | Compile TypeScript |
| `pnpm start:prod` | Run compiled production build |
| `pnpm lint` | Run ESLint with auto-fix |
| `pnpm format` | Format code with Prettier |
| `pnpm type-check` | TypeScript type validation (no emit) |
| `pnpm test` | Run unit tests |
| `pnpm test:e2e` | Run end-to-end tests |
| `pnpm prisma:generate` | Regenerate Prisma client |
| `pnpm prisma:migrate` | Create and apply a new migration |
| `pnpm prisma:migrate:deploy` | Apply pending migrations (production) |
| `pnpm prisma:migrate:reset` | Reset database and re-apply migrations |
| `pnpm prisma:studio` | Open Prisma Studio GUI |

### Docker

**Build and run the production Docker image:**

```bash
docker build -t Beacon .
docker run -p 3000:3000 \
  -e DATABASE_URL="postgresql://user:pass@host:5432/db" \
  -e JWT_SECRET="your-secret" \
  -e JWT_REFRESH_SECRET="your-refresh-secret" \
  -e RESEND_API_KEY="your-resend-key" \
  -e STORAGE_PUBLIC_ROOT="storage/public" \
  Beacon
```

The container automatically runs `prisma migrate deploy` before starting the server.

---

## Contributing

Contributions are welcome. Please read the [Contributing Guide](CONTRIBUTING.md) before submitting a pull request.

**Quick links:**
- [Contributing Guide](CONTRIBUTING.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security Policy](SECURITY.md)
- [Pull Request Template](.github/PULL_REQUEST_TEMPLATE.md)
- [Bug Report Template](.github/ISSUE_TEMPLATE/bug_report.md)
- [Feature Request Template](.github/ISSUE_TEMPLATE/feature_request.md)

**Repository:** [https://github.com/xuzuxing/beaconix](https://github.com/xuzuxing/beaconix)

---

## License

This project is based on team-flow by Khaled Saeed, licensed under the MIT License.

Modifications Copyright (c) 2026 Xu Zuxing, also released under the MIT License.

MIT License. See [LICENSE](LICENSE).
