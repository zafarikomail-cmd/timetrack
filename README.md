# ⏱️ TimeTrack

**A real-time, multi-user time tracking platform for teams.**
Employees clock in on a project with a mandatory task note. Admins get a live "who's working right now" dashboard, filterable reports with charts, and one-click Excel/CSV/Print export. Built with vanilla JavaScript and Supabase — no framework, no build step.

![Status](https://img.shields.io/badge/status-active-2563eb)
![Stack](https://img.shields.io/badge/stack-JS%20%2B%20Supabase-2563eb)
![License](https://img.shields.io/badge/license-Proprietary-lightgrey)

---

## Table of Contents

- [Overview](#overview)
- [Features](#features)
  - [Employee](#-employee)
  - [Admin](#-admin)
  - [Super Admin](#-super-admin)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Database Schema](#database-schema)
- [Roles & Permissions](#roles--permissions)
- [Getting Started](#getting-started)
- [Realtime Presence Model](#realtime-presence-model)
- [Exporting Data](#exporting-data)
- [Known Limitations](#known-limitations)
- [Roadmap Ideas](#roadmap-ideas)
- [License](#license)

---

## Overview

TimeTrack is a lightweight, responsive web app for logging and reporting employee working hours across projects. There's no self-signup — an admin adds every account statically, so there's nothing to configure beyond email/password/role. Every timer action is written straight to Supabase the instant it happens, so a crashed tab or an accidental refresh never costs anyone their working time.

The UI is light, blue-accented, and built to feel equally at home as a desktop dashboard or a phone-in-your-pocket app.

## Features

### 👤 Employee

- Pick a project from a searchable list and **Start / Pause / Resume / Stop** a timer
- A task description is **required** before starting — no blank, untracked time
- Date/time is captured server-side, never trusted from the client clock
- Personal **session history**, filterable by date range and project
- **Crash recovery** — if a tab closes mid-session, the next visit detects the orphaned timer and offers to resume or cleanly stop it, rather than silently losing time
- Personal **Overview** page with charts (hours by project, daily/weekly trend, cumulative hours)
- Export own working hours (Excel / CSV), filtered by date
- Profile page with a WhatsApp-style **initials avatar** (deterministic color per user, no photo needed)

### 🛡️ Admin

- Create, edit, and delete projects (name + description — description is admin-only, hidden from employees)
- **Archive instead of delete** for any project with time sessions already logged against it, so historical hours in Reports/Overview are never destroyed by a foreign-key conflict
- Add, edit, delete, promote, and demote user accounts — no public signup, ever
- **Live presence** on the Users table: see at a glance who's *Online* vs *Offline*, and — in a separate column — whether their **timer** is actually *Working*, *Paused*, or *Not working* right now, powered by Supabase Realtime (no refresh needed)
- Filter users by role, presence, and timer state simultaneously
- Send an in-app notification to any user
- Full **team Reports** page:
  - KPI cards (Total Hours, Users, Projects, Sessions)
  - 5 charts: hours by project, top contributors, daily hours (7d), trend (30d), cumulative hours (30d)
  - Filter by user, project, and date (presets + custom range)
  - **Export Excel** — a real styled `.xlsx` (colored header, zebra rows, frozen header, auto-filter) with a second sheet embedding PNG snapshots of every chart
  - **Export CSV** — plain, spreadsheet-ready
  - **Print** — opens a clean, self-contained printable report (KPI summary + applied filters + table), independent of the app's own sidebar/theme
- Everything an Employee can do, too (own timer, own overview, own exports)

### 👑 Super Admin

- One constant, un-deletable super admin account
- The only role that can promote a user to Admin, or demote an Admin back to Employee
- **Invisible to everyone else** — including regular Admins never see the Super Admin in user lists, filters, or role dropdowns
- Full Employee + Admin capability on top of that

## Tech Stack

| Layer | Choice |
|---|---|
| Frontend | Vanilla JavaScript (ES modules), no framework, no bundler |
| Backend / DB | [Supabase](https://supabase.com) — Postgres, Auth, Realtime, Edge Functions |
| Privileged writes | Supabase Edge Functions (service role) — `admin-create-user`, `admin-delete-user`, `admin-update-user-role` |
| Realtime | Supabase Postgres Changes (`work_sessions`) + Presence channel (`online_users`) |
| Charts | [Chart.js](https://www.chartjs.org/) + `chartjs-plugin-datalabels` |
| Excel export | [ExcelJS](https://github.com/exceljs/exceljs) (styled cells, embedded chart images) |
| CSV export | Hand-rolled RFC-4180-ish escaper, no dependency |
| Auth model | Static, admin-provisioned accounts — no public self-signup |

## Project Structure

```
├── app.html                     # Main authenticated app (all pages/sections)
├── login.html                   # Static login page
├── css/
│   ├── app.css / theme.css      # Global theme (light + blue)
│   ├── Users.css                # Users page
│   ├── Reports.css              # Reports page (incl. print stylesheet)
│   ├── Dashboard.css / Project.css / Overview.css / Profile.css
├── js/
│   ├── auth.js                  # getCurrentUser() and session handling
│   ├── data.js                  # Shared Supabase data-access layer
│   ├── presence.js              # Realtime "who's working now" + tab-open presence
│   ├── users.js                 # Admin: manage users
│   ├── projects.js              # Timer UI + Admin: manage projects
│   ├── reports.js               # Admin: team reports, charts, exports
│   ├── overview.js               # Personal/team overview charts
│   ├── profile.js               # Profile page + personal export
│   ├── export.js                # Shared Excel/CSV/Print export helpers
│   ├── charts.js                # Chart.js wrapper + color palette
│   ├── report-utils.js          # Pure date/aggregation/formatting helpers
│   ├── notifications.js / toast.js / modal.js / pagination.js / navigation.js
│   └── vendor/                  # chart.umd.js, chartjs-plugin-datalabels.min.js
├── supabase/
│   ├── functions/
│   │   ├── admin-create-user/
│   │   ├── admin-delete-user/
│   │   └── admin-update-user-role/
│   └── migrations/
│       ├── 0001_init.sql
│       └── 0002_notifications.sql
└── README.md
```

## Database Schema

| Table | Purpose |
|---|---|
| `profiles` | One row per user — `full_name`, `email`, `role` (`employee` / `admin` / `super_admin`), `created_at`. Role lives **only** here, never on the raw auth user. |
| `projects` | `name`, `description` (admin-only), `status` (`active` / `completed` / `archived`), `created_at` |
| `project_members` | Membership rows used for per-project member counts |
| `work_sessions` | The timer log: `user_id`, `project_id`, `task_description`, `started_at`, `status` (`running` / `paused` / `completed`), `paused_at`, `duration_seconds`, `last_heartbeat_at`, `task_status` (`completed` / `in_progress` / `blocked`) |
| `notifications` | In-app notifications sent from Admin to a specific user |

> ⚠️ `work_sessions.project_id` and `project_members.project_id` both have a foreign key back to `projects`. Deleting a project with existing sessions will fail (`23503`) by design — archive it instead (the app does this automatically via the Delete flow).

## Roles & Permissions

| Capability | Employee | Admin | Super Admin |
|---|:---:|:---:|:---:|
| Track own time | ✅ | ✅ | ✅ |
| See own overview / export own data | ✅ | ✅ | ✅ |
| See project descriptions | ❌ | ✅ | ✅ |
| Manage projects (add/edit/archive) | ❌ | ✅ | ✅ |
| Manage users (add/edit/delete) | ❌ | ✅ | ✅ |
| Promote Employee → Admin / demote Admin → Employee | ❌ | ❌ | ✅ |
| Visible in user lists | ✅ | ✅ | ❌ (hidden from everyone) |
| Team Reports & exports | ❌ | ✅ | ✅ |

## Getting Started

1. **Create a Supabase project** at [supabase.com](https://supabase.com).
2. Run the migrations in `supabase/migrations/` (SQL Editor or the Supabase CLI) to create the tables and RLS policies.
3. Deploy the three Edge Functions in `supabase/functions/` — these use the service role key to create/delete users and change roles, since those actions must bypass RLS.
4. Add your Supabase project URL and anon key to `js/supabase.js`.
5. Statically seed at least one Super Admin (see `seed-super-admin.ts` or insert directly into `profiles` + Supabase Auth).
6. Serve the app with any static file server, e.g.:
   ```bash
   npx live-server .
   # or
   python3 -m http.server 5500
   ```
7. Open `login.html`, sign in as the seeded Super Admin, and start adding real users and projects from the Users/Projects pages — no further setup needed.

## Realtime Presence Model

Two independent signals combine to describe a user's state, so "browsing the app" and "actively timing something" are never conflated:

- **Presence channel (`online_users`)** — tracked via Supabase Presence; answers *"is their tab open right now?"* → shown as the `Status` badge (`Online` / `Offline`).
- **`work_sessions` Postgres Changes + heartbeat** — a running/paused session pings `last_heartbeat_at` every 60 seconds while the tab is open; a session with no heartbeat in 5+ minutes is treated as abandoned even if the row is still technically "open." This answers *"is their timer actually running?"* → shown as the separate `Timer` badge (`Working` / `Paused` / `Not working`).

## Exporting Data

All three export paths (Excel, CSV, Print) are built from **the exact same filtered dataset** as what's on screen, so the numbers can never drift between what an admin sees and what they hand off.

- **Excel** — styled `.xlsx` via ExcelJS: colored header row, zebra striping, frozen header, auto-filter, plus a `Charts` sheet with PNG snapshots of every chart on the page.
- **CSV** — dependency-free, RFC-4180-safe escaping.
- **Print** — opens a dedicated print window (not just `window.print()` on the live app) with its own KPI summary, applied-filters line, generated-at timestamp, and a clean bordered table — so the printed page is a self-contained report, not a screenshot of the dashboard chrome.

## Known Limitations

- No public self-signup by design — every account is provisioned by an Admin/Super Admin.
- Presence relies on the tab staying open; a hard OS-level sleep/network drop can take up to the heartbeat interval to reflect as "offline."
- Print currently exports the detailed table + KPIs, not the charts themselves (Excel export does include chart images).

## Roadmap Ideas

- [ ] Filter/hide archived projects from the Manage Projects table by default
- [ ] Weekly digest email summarizing team hours (via a scheduled Edge Function)
- [ ] Per-project budget/hour caps with an over-budget warning badge
- [ ] Dark mode toggle alongside the existing light/blue theme

## License

Proprietary — all rights reserved. *(Replace this section if you intend to open-source the project.)*
