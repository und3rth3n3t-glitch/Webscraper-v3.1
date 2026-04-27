# WebScrape Backend

Backend + web UI for the blueberry-v3 browser extension. Owns task definitions, queues, runs, and results.

## Repo layout

- `src/WebScrape.Server/` — ASP.NET Core host, controllers, SignalR hub, auth handlers
- `src/WebScrape.Services/` — business logic services
- `src/WebScrape.Data/` — DbContext, entities, DTOs, AutoMapper profiles
- `src/WebScrape.Client/` — React + Vite + TS frontend
- `tests/WebScrape.Tests/` — xUnit + Moq + AutoFixture tests

## Local development (no Docker)

Prerequisites: .NET SDK 9, PostgreSQL 17 reachable on `localhost:5432`.

```bash
cp src/WebScrape.Server/appsettings.Development.json.template src/WebScrape.Server/appsettings.Development.json
# Edit the connection string for your local Postgres.

dotnet restore WebScrape.sln
dotnet build WebScrape.sln
dotnet ef database update --project src/WebScrape.Data --startup-project src/WebScrape.Server
dotnet run --project src/WebScrape.Server   # listens on http://localhost:5082
dotnet test tests/WebScrape.Tests
```

Frontend dev server (separate process):

```bash
cd src/WebScrape.Client
npm install
npm run dev   # http://localhost:5173, proxies /api to localhost:5082
```

## Local development (Docker Compose)

```bash
docker compose up -d
# Backend at http://localhost:5082; DB on localhost:5432.
```

The first start auto-applies migrations and seeds an admin user (`admin@local` / `admin123`) plus a demo config + task.

## Production deployment

The prod compose does **not** expose the server publicly. Front it with a reverse proxy that terminates TLS.

```bash
cp .env.prod.example .env.prod
# Edit .env.prod — set POSTGRES_PASSWORD and ConnectionStrings__Default.

docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

### TLS termination

You bring your own reverse proxy. Two common choices:

#### Caddy (auto Let's Encrypt)

`Caddyfile`:
```
webscrape.example.com {
    reverse_proxy server:8080
}
```

Run Caddy on the same docker network as the compose stack (`docker network connect <network> caddy`).

#### Traefik (auto Let's Encrypt)

Add labels to the `server` service in your override compose:
```yaml
  server:
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.webscrape.rule=Host(`webscrape.example.com`)"
      - "traefik.http.routers.webscrape.entrypoints=websecure"
      - "traefik.http.routers.webscrape.tls.certresolver=letsencrypt"
      - "traefik.http.services.webscrape.loadbalancer.server.port=8080"
```

### Centralised logging (optional)

To pipe logs to [Seq](https://datalust.co/seq):

```bash
docker run -d --name seq --network <stack-network> \
  -e ACCEPT_EULA=Y -p 5340:80 -p 5341:5341 \
  datalust/seq:latest
```

Then in `.env.prod`:
```
Serilog__Seq__Enabled=true
Serilog__Seq__ServerUrl=http://seq:5341
```

Restart the server. Logs appear at `http://<host>:5340`.

## On first start

`InitialSeed` creates an admin user (`admin@local` / `admin123`) plus one demo `ScraperConfig` and one demo `Task` if no users exist. The seeded credentials are dev-only — change immediately in any non-throwaway deployment.
