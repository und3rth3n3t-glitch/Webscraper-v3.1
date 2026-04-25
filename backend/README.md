# WebScrape

Backend + web UI for the blueberry-v3 browser extension. Owns task definitions, queues, runs, and results.

This repo contains the M1.1 milestone — the backend solution skeleton. The extension changes (M1.2), web UI (M1.3), Docker Compose (M1.4), and verification (M1.5) land in subsequent milestones.

## Repo layout

- `src/WebScrape.Server/` — ASP.NET Core host, controllers, SignalR hub, auth handlers
- `src/WebScrape.Services/` — business logic services
- `src/WebScrape.Data/` — DbContext, entities, DTOs, AutoMapper profiles
- `src/WebScrape.Client/` — React + Vite + TS frontend (M1.3, not present yet)
- `tests/WebScrape.Tests/` — xUnit + Moq + AutoFixture tests

## Prerequisites

- .NET SDK 9 (spec called for .NET 8; this repo targets .NET 9 because that's what's installed locally)
- PostgreSQL 16 reachable on `localhost:5432` (or update connection string)

## First-time setup

1. Copy the dev settings template:
   ```bash
   cp src/WebScrape.Server/appsettings.Development.json.template src/WebScrape.Server/appsettings.Development.json
   ```
   Edit the connection string if your local Postgres credentials differ.

2. Restore + build:
   ```bash
   dotnet restore WebScrape.sln
   dotnet build WebScrape.sln
   ```

3. Apply migrations (requires Postgres running):
   ```bash
   dotnet ef database update \
     --project src/WebScrape.Data \
     --startup-project src/WebScrape.Server
   ```

4. Run the server:
   ```bash
   dotnet run --project src/WebScrape.Server
   ```
   Listens on `http://localhost:5000` by default.

5. Run tests:
   ```bash
   dotnet test tests/WebScrape.Tests
   ```

## On first start

`InitialSeed` creates an admin user (`admin@local` / `admin`) plus one demo `ScraperConfig` and one demo `Task` if no users exist. The seeded credentials are dev-only.
