# SPEC: WebScrape Frontend (M1.3)

**Parent spec:** [SPEC-webscrape-v1.0.md](./SPEC-webscrape-v1.0.md), section "M1.3 — Frontend".
**Implementation target:** `c:\Users\und3r\webscrape\src\WebScrape.Client\` (does not exist yet).
**Acceptance gate:** M1.5 verification steps 3–16 (in parent spec) pass end-to-end.

---

## Context

The WebScrape backend (running at `http://localhost:5082`) is complete; the extension's queue mode (M1.2) is wired and waiting. To prove the protocol end-to-end we need just enough web UI to log in, mint a PAT, see workers, fire a run, and watch results stream back. M2 is full task authoring; this spec is **strictly the M1.5 driver**. A dev will harden it afterward — do not add anything not listed here.

---

## Decisions deviating from the parent spec

| # | Parent spec said | This spec says | Why |
|---|---|---|---|
| 1 | Tailwind 3, no component library | **Drop Tailwind. Reuse the extension's CSS.** Copy [c:\Users\und3r\blueberry-v3\src\sidepanel\styles\index.css](c:\Users\und3r\blueberry-v3\src\sidepanel\styles\index.css) verbatim into the frontend, then append a small desktop-overrides block (see [§ 4.3](#43-srcindexcss)). | The extension already has `.btn`, `.list-card`, `.run-progress-bar-*`, `.run-banner-*`, `.modal-*`, `.status-dot.*`, `.empty-state` etc. with brand tokens. Pixel-matching the extension is faster and the user explicitly asked for it. |
| 2 | Vite proxy target `http://localhost:5000` | **Target `http://localhost:5082`** | Backend port deviation noted in `webscrape_initiative.md`. |
| 3 | "Auth gate redirects to `/login` on 401" (vague) | Concrete pattern: TanStack Query `['me']` is the source of truth. axios 401 interceptor sets `queryClient.setQueryData(['me'], null)`; `AuthShell` reads `['me']` and renders `<Navigate to="/login" />` when null. | HttpOnly cookie can't be read from JS — `me` query is the only signal. |
| 4 | "TanStack Query 5" — no specifics | `staleTime: 30_000` for lists, `refetchInterval: 5000` for `/workers`, `refetchInterval: 1000` for `/runs/:id` (only while non-terminal). | Polling load on backend stays predictable. |
| 5 | "Modal" for token display — no library | **Custom 30-line component** using the extension's `.modal-overlay` + `.modal-box` classes. No Headless UI / Radix dep. | One modal in the whole app; not worth a dep. |
| 6 | "Worker dropdown" (vague) | Click "Run on…" → opens a confirm modal with task name + `<select>` of online workers + Cancel / Run. | Clearer than inline-expanding rows; uses the existing modal. |

---

## Stack (pinned)

| Package | Version | Purpose |
|---|---|---|
| `react`, `react-dom` | `^18.3.0` | UI |
| `react-router-dom` | `^6.26.0` | Routing (BrowserRouter, not data router — simpler for M1) |
| `@tanstack/react-query` | `^5.51.0` | Server state |
| `axios` | `^1.7.0` | HTTP |
| `vite` | `^5.4.0` | Dev server, build |
| `@vitejs/plugin-react` | `^4.3.0` | Vite React plugin |
| `typescript` | `^5.5.0` | Types |
| `@types/react`, `@types/react-dom` | `^18.3.0` | React types |

**No Tailwind. No PostCSS. No Headless UI. No SignalR client** (run page polls REST per parent spec; SignalR for the UI is M3+).

---

## File-by-file

Directory tree to produce:

```
c:\Users\und3r\webscrape\src\WebScrape.Client\
├── package.json
├── tsconfig.json
├── tsconfig.node.json
├── vite.config.ts
├── index.html
├── .gitignore
└── src\
    ├── main.tsx
    ├── App.tsx
    ├── index.css
    ├── api\
    │   ├── client.ts
    │   ├── types.ts
    │   ├── queries.ts
    │   └── mutations.ts
    ├── components\
    │   ├── Sidebar.tsx
    │   └── Modal.tsx
    └── pages\
        ├── Login.tsx
        ├── ApiKeys.tsx
        ├── Workers.tsx
        ├── Tasks.tsx
        └── RunDetail.tsx
```

### 1. Tier-1: project scaffold

#### 1.1 `package.json`

```json
{
  "name": "webscrape-client",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@tanstack/react-query": "^5.51.0",
    "axios": "^1.7.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "react-router-dom": "^6.26.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^5.5.0",
    "vite": "^5.4.0"
  }
}
```

#### 1.2 `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

#### 1.3 `tsconfig.node.json`

```json
{
  "compilerOptions": {
    "composite": true,
    "skipLibCheck": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowSyntheticDefaultImports": true,
    "strict": true
  },
  "include": ["vite.config.ts"]
}
```

#### 1.4 `vite.config.ts`

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:5082',
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
```

#### 1.5 `index.html`

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>WebScrape</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

#### 1.6 `.gitignore`

```
node_modules/
dist/
.vite/
*.local
```

---

### 2. Tier-2: app shell

#### 2.1 `src/main.tsx`

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { ensureCsrfCookie, setQueryClient } from './api/client';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
});

setQueryClient(queryClient);

await ensureCsrfCookie();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
);
```

#### 2.2 `src/App.tsx`

```tsx
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { useMe } from './api/queries';
import Sidebar from './components/Sidebar';
import Login from './pages/Login';
import ApiKeys from './pages/ApiKeys';
import Workers from './pages/Workers';
import Tasks from './pages/Tasks';
import RunDetail from './pages/RunDetail';

function AuthShell() {
  const { data: me, isPending } = useMe();
  const location = useLocation();
  if (isPending) return null;
  if (!me) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return (
    <div className="app">
      <header className="header">
        <h1 style={{ color: 'white', fontSize: 'var(--font-size-xl)', fontWeight: 700, letterSpacing: '-0.3px' }}>
          WebScrape
        </h1>
        <span className="header-version">{me.email}</span>
      </header>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <Sidebar />
        <main className="app-content" style={{ flex: 1 }}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<AuthShell />}>
        <Route index element={<Navigate to="/tasks" replace />} />
        <Route path="/tasks" element={<Tasks />} />
        <Route path="/workers" element={<Workers />} />
        <Route path="/api-keys" element={<ApiKeys />} />
        <Route path="/runs/:id" element={<RunDetail />} />
      </Route>
    </Routes>
  );
}
```

#### 2.3 `src/index.css`

**Step 1**: copy the entire file [c:\Users\und3r\blueberry-v3\src\sidepanel\styles\index.css](c:\Users\und3r\blueberry-v3\src\sidepanel\styles\index.css) verbatim as the start of `src/index.css`.

**Step 2**: append the following desktop-layout overrides at the end:

```css
/* ===== Desktop overrides (frontend only) ===== */
html, body, #root { height: 100%; overflow: hidden; }

.app { height: 100vh; }

.app-content {
  padding: var(--spacing-xl);
  background: linear-gradient(135deg, #FEFEFE 0%, #F5F0FA 100%);
}

.app-content::-webkit-scrollbar { width: 8px; }
.app-content::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }

.header {
  justify-content: space-between;
  padding: var(--spacing-md) var(--spacing-2xl);
}

.header-version {
  position: static;
  font-size: var(--font-size-sm);
  color: rgba(255, 255, 255, 0.85);
  letter-spacing: 0;
}

/* ===== Sidebar nav (frontend only) ===== */
.sidebar {
  width: 200px;
  background: var(--bg-white);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  padding: var(--spacing-md) 0;
  flex-shrink: 0;
}

.sidebar-link {
  display: block;
  padding: var(--spacing-sm) var(--spacing-lg);
  color: var(--text-dark);
  text-decoration: none;
  font-size: var(--font-size-sm);
  font-weight: 500;
  border-left: 3px solid transparent;
  transition: background var(--transition), color var(--transition), border-color var(--transition);
}
.sidebar-link:hover { background: var(--bg-hover); color: var(--purple-primary); }
.sidebar-link.active { color: var(--purple-primary); border-left-color: var(--purple-primary); background: var(--purple-bg); }

.sidebar-spacer { flex: 1; }

.sidebar-logout {
  margin: var(--spacing-md) var(--spacing-lg) 0;
}

/* ===== Login (frontend only) ===== */
.login-page {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  background: linear-gradient(135deg, #FEFEFE 0%, #F5F0FA 100%);
  padding: var(--spacing-xl);
}
.login-card {
  width: 100%;
  max-width: 360px;
  padding: var(--spacing-2xl);
}
.login-title {
  font-size: var(--font-size-xl);
  font-weight: 700;
  color: var(--purple-primary);
  text-align: center;
  margin-bottom: var(--spacing-lg);
}

/* ===== Data tables (frontend only) ===== */
.data-table {
  width: 100%;
  border-collapse: collapse;
  background: var(--bg-white);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  overflow: hidden;
  font-size: var(--font-size-sm);
}
.data-table th {
  background: var(--bg-light);
  padding: var(--spacing-sm) var(--spacing-md);
  text-align: left;
  font-weight: 600;
  color: var(--text-dark);
  border-bottom: 1px solid var(--border);
}
.data-table td {
  padding: var(--spacing-sm) var(--spacing-md);
  border-bottom: 1px solid var(--bg-light);
  color: var(--text-dark);
}
.data-table tr:last-child td { border-bottom: none; }
.data-table tr:hover td { background: var(--bg-hover); }

/* ===== Token reveal (frontend only) ===== */
.token-reveal {
  background: var(--bg-light);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: var(--spacing-md);
  font-family: monospace;
  font-size: var(--font-size-sm);
  color: var(--text-dark);
  word-break: break-all;
  margin: var(--spacing-md) 0;
}

.danger-banner {
  background: var(--danger-light);
  border-left: 3px solid var(--danger);
  padding: var(--spacing-sm) var(--spacing-md);
  border-radius: var(--radius-sm);
  font-size: var(--font-size-sm);
  color: var(--danger);
  margin-bottom: var(--spacing-md);
}
```

---

### 3. Tier-3: HTTP layer

#### 3.1 `src/api/types.ts`

```ts
// Wire DTOs — must match backend exactly. Field names are camelCase per Program.cs JsonOptions.

export type AccountDto = {
  id: string;       // Guid serialized as string
  email: string;
  name: string | null;
};

export type ApiKeyDto = {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;            // ISO 8601 with offset
  lastUsedAt: string | null;
  revokedAt: string | null;
};

export type CreateApiKeyResponseDto = {
  id: string;
  name: string;
  prefix: string;
  token: string;                // raw wsk_... — shown ONCE
};

export type TaskDto = {
  id: string;
  name: string;
  scraperConfigId: string;
  scraperConfigName: string;
  searchTerms: string[];
  createdAt: string;
};

export type WorkerDto = {
  id: string;
  name: string;
  online: boolean;
  lastSeenAt: string | null;
  extensionVersion: string | null;
};

export type RunStatus = 'pending' | 'sent' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

export type RunItemDto = {
  id: string;
  taskId: string;
  workerId: string;
  status: RunStatus;
  requestedAt: string;
  sentAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  result: unknown | null;
  errorMessage: string | null;
  pauseReason: string | null;
  progressPercent: number | null;
  currentTerm: string | null;
  currentStep: string | null;
  phase: string | null;
};

export type CreateRunSuccess = { runItemId: string };
export type CreateRunFailure = { runItemId?: string; error: string };

export const TERMINAL_STATUSES: RunStatus[] = ['completed', 'failed', 'cancelled'];
```

#### 3.2 `src/api/client.ts`

```ts
import axios, { AxiosError } from 'axios';
import type { QueryClient } from '@tanstack/react-query';

const CSRF_COOKIE = 'XSRF-TOKEN';
const CSRF_HEADER = 'X-XSRF-TOKEN';
const UNSAFE = new Set(['post', 'put', 'patch', 'delete']);

function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

export const api = axios.create({
  baseURL: '/',
  withCredentials: true,
});

api.interceptors.request.use((config) => {
  const method = (config.method ?? 'get').toLowerCase();
  if (UNSAFE.has(method)) {
    const token = readCookie(CSRF_COOKIE);
    if (token) config.headers.set(CSRF_HEADER, token);
  }
  return config;
});

let queryClient: QueryClient | null = null;
export function setQueryClient(c: QueryClient) { queryClient = c; }

api.interceptors.response.use(
  (r) => r,
  (err: AxiosError) => {
    if (err.response?.status === 401 && queryClient) {
      queryClient.setQueryData(['me'], null);
    }
    return Promise.reject(err);
  }
);

export async function ensureCsrfCookie(): Promise<void> {
  if (!readCookie(CSRF_COOKIE)) {
    try { await api.get('/api/account/csrf'); } catch { /* ignore — login flow will surface real errors */ }
  }
}
```

#### 3.3 `src/api/queries.ts`

```ts
import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { api } from './client';
import type { AccountDto, ApiKeyDto, RunItemDto, TaskDto, WorkerDto } from './types';
import { TERMINAL_STATUSES } from './types';

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        const { data } = await api.get<AccountDto>('/api/account/me');
        return data;
      } catch (e) {
        if (axios.isAxiosError(e) && e.response?.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
  });
}

export function useApiKeys() {
  return useQuery({
    queryKey: ['api-keys'],
    queryFn: async () => (await api.get<ApiKeyDto[]>('/api/api-keys')).data,
  });
}

export function useTasks() {
  return useQuery({
    queryKey: ['tasks'],
    queryFn: async () => (await api.get<TaskDto[]>('/api/tasks')).data,
  });
}

export function useWorkers() {
  return useQuery({
    queryKey: ['workers'],
    queryFn: async () => (await api.get<WorkerDto[]>('/api/workers')).data,
    refetchInterval: 5000,
  });
}

export function useRun(id: string | undefined) {
  return useQuery({
    queryKey: ['run', id],
    enabled: !!id,
    queryFn: async () => (await api.get<RunItemDto>(`/api/runs/${id}`)).data,
    refetchInterval: (query) => {
      const data = query.state.data as RunItemDto | undefined;
      if (!data) return 1000;
      return TERMINAL_STATUSES.includes(data.status) ? false : 1000;
    },
  });
}
```

#### 3.4 `src/api/mutations.ts`

```ts
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from './client';
import type { AccountDto, CreateApiKeyResponseDto, CreateRunSuccess } from './types';

export function useLogin() {
  const qc = useQueryClient();
  const nav = useNavigate();
  return useMutation({
    mutationFn: async (body: { email: string; password: string }) =>
      (await api.post<AccountDto>('/api/account/login', body)).data,
    onSuccess: (data) => {
      qc.setQueryData(['me'], data);
      nav('/tasks', { replace: true });
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  const nav = useNavigate();
  return useMutation({
    mutationFn: async () => { await api.post('/api/account/logout'); },
    onSuccess: () => {
      qc.setQueryData(['me'], null);
      qc.removeQueries();
      nav('/login', { replace: true });
    },
  });
}

export function useCreateApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { name: string }) =>
      (await api.post<CreateApiKeyResponseDto>('/api/api-keys', body)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['api-keys'] }),
  });
}

export function useRevokeApiKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => { await api.delete(`/api/api-keys/${id}`); },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['api-keys'] }),
  });
}

export function useStartRun() {
  const nav = useNavigate();
  return useMutation({
    mutationFn: async (body: { taskId: string; workerId: string }) =>
      (await api.post<CreateRunSuccess>('/api/runs', body)).data,
    onSuccess: (data) => nav(`/runs/${data.runItemId}`),
  });
}
```

---

### 4. Tier-4: shared components

#### 4.1 `src/components/Sidebar.tsx`

```tsx
import { NavLink } from 'react-router-dom';
import { useLogout } from '../api/mutations';

export default function Sidebar() {
  const logout = useLogout();
  return (
    <nav className="sidebar">
      <NavLink to="/tasks" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>Tasks</NavLink>
      <NavLink to="/workers" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>Workers</NavLink>
      <NavLink to="/api-keys" className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}>API Keys</NavLink>
      <div className="sidebar-spacer" />
      <button
        className="btn btn-ghost btn-sm sidebar-logout"
        onClick={() => logout.mutate()}
        disabled={logout.isPending}
      >
        Sign out
      </button>
    </nav>
  );
}
```

#### 4.2 `src/components/Modal.tsx`

```tsx
import { ReactNode, useEffect } from 'react';

type Props = {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
};

export default function Modal({ open, title, onClose, children }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="modal-box-header">
          <span className="modal-title">{title}</span>
          <button className="modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}
```

---

### 5. Tier-5: pages

#### 5.1 `src/pages/Login.tsx`

```tsx
import { FormEvent, useState } from 'react';
import { Navigate } from 'react-router-dom';
import axios from 'axios';
import { useLogin } from '../api/mutations';
import { useMe } from '../api/queries';

export default function Login() {
  const [email, setEmail] = useState('admin@local');
  const [password, setPassword] = useState('admin');
  const login = useLogin();
  const { data: me, isPending } = useMe();

  if (!isPending && me) return <Navigate to="/tasks" replace />;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate({ email, password });
  };

  const errMsg = (() => {
    const e = login.error;
    if (!e) return null;
    if (axios.isAxiosError(e)) {
      const data = e.response?.data as { error?: string } | undefined;
      return data?.error ?? 'Sign in failed.';
    }
    return 'Sign in failed.';
  })();

  return (
    <div className="login-page">
      <form className="card login-card" onSubmit={onSubmit}>
        <div className="login-title">WebScrape</div>
        {errMsg && <div className="danger-banner">{errMsg}</div>}
        <div className="form-group">
          <label className="form-label" htmlFor="email">Email</label>
          <input
            id="email"
            className="form-input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
          />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="password">Password</label>
          <input
            id="password"
            className="form-input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </div>
        <button type="submit" className="btn btn-primary btn-full" disabled={login.isPending}>
          {login.isPending ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
```

#### 5.2 `src/pages/ApiKeys.tsx`

```tsx
import { useState } from 'react';
import { useApiKeys } from '../api/queries';
import { useCreateApiKey, useRevokeApiKey } from '../api/mutations';
import Modal from '../components/Modal';
import type { CreateApiKeyResponseDto } from '../api/types';

function fmtDate(s: string | null): string {
  if (!s) return '—';
  return new Date(s).toLocaleString();
}

export default function ApiKeys() {
  const { data: keys, isPending } = useApiKeys();
  const create = useCreateApiKey();
  const revoke = useRevokeApiKey();

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [revealed, setRevealed] = useState<CreateApiKeyResponseDto | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<{ id: string; name: string } | null>(null);

  const submit = async () => {
    if (!name.trim()) return;
    const result = await create.mutateAsync({ name: name.trim() });
    setName('');
    setCreateOpen(false);
    setRevealed(result);
  };

  const doRevoke = async () => {
    if (!confirmRevoke) return;
    await revoke.mutateAsync(confirmRevoke.id);
    setConfirmRevoke(null);
  };

  return (
    <div className="view">
      <div className="view-header-row" style={{ justifyContent: 'space-between' }}>
        <h2 className="view-title">API Keys</h2>
        <button className="btn btn-primary" onClick={() => setCreateOpen(true)}>+ Create key</button>
      </div>

      {isPending && <div className="loading-state">Loading…</div>}

      {!isPending && keys && keys.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-title">No API keys yet</div>
          <div className="empty-state-desc">Create one to connect a browser extension to your backend.</div>
        </div>
      )}

      {!isPending && keys && keys.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Prefix</th>
              <th>Created</th>
              <th>Last used</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id}>
                <td>{k.name}</td>
                <td><code>{k.prefix}…</code></td>
                <td>{fmtDate(k.createdAt)}</td>
                <td>{fmtDate(k.lastUsedAt)}</td>
                <td>{k.revokedAt ? <span className="text-danger">Revoked</span> : <span className="text-success">Active</span>}</td>
                <td>
                  {!k.revokedAt && (
                    <button
                      className="btn btn-danger btn-sm"
                      onClick={() => setConfirmRevoke({ id: k.id, name: k.name })}
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Create API key">
        <div className="form-group">
          <label className="form-label" htmlFor="key-name">Name</label>
          <input
            id="key-name"
            className="form-input"
            placeholder="e.g. Office laptop"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          <div className="form-hint">Pick something memorable so you can find this key later.</div>
        </div>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={() => setCreateOpen(false)}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={create.isPending || !name.trim()}>
            {create.isPending ? 'Creating…' : 'Create'}
          </button>
        </div>
      </Modal>

      <Modal open={!!revealed} onClose={() => setRevealed(null)} title={`Key created: ${revealed?.name ?? ''}`}>
        <div className="danger-banner">
          Copy this token now. It won't be shown again — if you lose it, you'll need to create a new key.
        </div>
        <div className="token-reveal">{revealed?.token}</div>
        <div className="modal-actions">
          <button
            className="btn btn-secondary"
            onClick={() => { if (revealed) navigator.clipboard.writeText(revealed.token); }}
          >
            Copy
          </button>
          <button className="btn btn-primary" onClick={() => setRevealed(null)}>I've copied it</button>
        </div>
      </Modal>

      <Modal open={!!confirmRevoke} onClose={() => setConfirmRevoke(null)} title="Revoke this key?">
        <div className="modal-body">
          Any extension still using <strong>{confirmRevoke?.name}</strong> will be disconnected. This can't be undone.
        </div>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={() => setConfirmRevoke(null)}>Cancel</button>
          <button className="btn btn-danger" onClick={doRevoke} disabled={revoke.isPending}>
            {revoke.isPending ? 'Revoking…' : 'Revoke'}
          </button>
        </div>
      </Modal>
    </div>
  );
}
```

#### 5.3 `src/pages/Workers.tsx`

```tsx
import { useWorkers } from '../api/queries';

function fmtRelative(s: string | null): string {
  if (!s) return 'never';
  const ms = Date.now() - new Date(s).getTime();
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return new Date(s).toLocaleDateString();
}

export default function Workers() {
  const { data: workers, isPending } = useWorkers();

  return (
    <div className="view">
      <h2 className="view-title">Workers</h2>
      <div className="view-subtitle">Browser extensions connected to this backend.</div>

      {isPending && <div className="loading-state">Loading…</div>}

      {!isPending && workers && workers.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-title">No workers yet</div>
          <div className="empty-state-desc">Open the extension, paste an API key, and switch the mode to Queue.</div>
        </div>
      )}

      {!isPending && workers && workers.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>Version</th>
              <th>Last seen</th>
            </tr>
          </thead>
          <tbody>
            {workers.map((w) => (
              <tr key={w.id}>
                <td>{w.name}</td>
                <td>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <span className={`status-dot ${w.online ? 'success' : 'pending'}`} />
                    {w.online ? 'Online' : 'Offline'}
                  </span>
                </td>
                <td>{w.extensionVersion ?? '—'}</td>
                <td>{fmtRelative(w.lastSeenAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

#### 5.4 `src/pages/Tasks.tsx`

```tsx
import { useState } from 'react';
import axios from 'axios';
import { useTasks, useWorkers } from '../api/queries';
import { useStartRun } from '../api/mutations';
import Modal from '../components/Modal';
import type { TaskDto } from '../api/types';

export default function Tasks() {
  const { data: tasks, isPending } = useTasks();
  const { data: workers } = useWorkers();
  const startRun = useStartRun();

  const [picking, setPicking] = useState<TaskDto | null>(null);
  const [workerId, setWorkerId] = useState<string>('');

  const onlineWorkers = (workers ?? []).filter((w) => w.online);

  const openPicker = (t: TaskDto) => {
    setPicking(t);
    setWorkerId(onlineWorkers[0]?.id ?? '');
  };

  const submit = async () => {
    if (!picking || !workerId) return;
    try {
      await startRun.mutateAsync({ taskId: picking.id, workerId });
      setPicking(null);
    } catch {
      // error rendered inline below
    }
  };

  const errMsg = (() => {
    const e = startRun.error;
    if (!e) return null;
    if (axios.isAxiosError(e)) {
      const data = e.response?.data as { error?: string } | undefined;
      return data?.error ?? 'Could not start the run.';
    }
    return 'Could not start the run.';
  })();

  return (
    <div className="view">
      <h2 className="view-title">Tasks</h2>
      <div className="view-subtitle">Pick a task and a worker to send it to.</div>

      {isPending && <div className="loading-state">Loading…</div>}

      {!isPending && tasks && tasks.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-title">No tasks yet</div>
          <div className="empty-state-desc">Tasks come from your seeded data or the task editor (coming soon).</div>
        </div>
      )}

      {!isPending && tasks && tasks.length > 0 && (
        <div className="config-list">
          {tasks.map((t) => (
            <div key={t.id} className="card list-card config-card">
              <div className="config-card-header">
                <div className="config-card-name">{t.name}</div>
                <button className="btn btn-primary btn-sm" onClick={() => openPicker(t)}>
                  Run on…
                </button>
              </div>
              <div className="config-card-meta">
                <span className="domain-badge">{t.scraperConfigName}</span>
                <span className="meta-badge">{t.searchTerms.length} term{t.searchTerms.length === 1 ? '' : 's'}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal open={!!picking} onClose={() => setPicking(null)} title={`Run "${picking?.name ?? ''}"`}>
        {errMsg && <div className="danger-banner">{errMsg}</div>}
        <div className="form-group">
          <label className="form-label" htmlFor="worker-pick">Worker</label>
          {onlineWorkers.length === 0 ? (
            <div className="form-hint text-danger">No workers are online right now.</div>
          ) : (
            <select
              id="worker-pick"
              className="form-select"
              value={workerId}
              onChange={(e) => setWorkerId(e.target.value)}
            >
              {onlineWorkers.map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
          )}
        </div>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={() => setPicking(null)}>Cancel</button>
          <button
            className="btn btn-primary"
            onClick={submit}
            disabled={startRun.isPending || !workerId}
          >
            {startRun.isPending ? 'Starting…' : 'Run'}
          </button>
        </div>
      </Modal>
    </div>
  );
}
```

#### 5.5 `src/pages/RunDetail.tsx`

```tsx
import { useParams, Link } from 'react-router-dom';
import { useRun } from '../api/queries';
import type { RunStatus } from '../api/types';

const STATUS_LABELS: Record<RunStatus, string> = {
  pending: 'Waiting to send',
  sent: 'Sent to worker',
  running: 'Running',
  paused: 'Paused',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const BANNER_CLASS: Partial<Record<RunStatus, string>> = {
  completed: 'run-banner-success',
  failed: 'run-banner-error',
  paused: 'run-banner-warning',
};

export default function RunDetail() {
  const { id } = useParams();
  const { data: run, isPending, error } = useRun(id);

  if (isPending) return <div className="view"><div className="loading-state">Loading…</div></div>;
  if (error || !run) return <div className="view"><div className="danger-banner">Couldn't load this run.</div></div>;

  const bannerClass = BANNER_CLASS[run.status] ?? '';
  const pct = run.progressPercent ?? 0;

  return (
    <div className="view">
      <div className="view-header-row">
        <Link to="/tasks" className="back-btn" aria-label="Back">←</Link>
        <h2 className="view-title">Run</h2>
      </div>

      {bannerClass && (
        <div className={`run-banner ${bannerClass}`}>
          {STATUS_LABELS[run.status]}{run.errorMessage ? ` — ${run.errorMessage}` : ''}
        </div>
      )}
      {!bannerClass && (
        <div className="view-subtitle">{STATUS_LABELS[run.status]}</div>
      )}

      <div className="run-progress-bar-wrap">
        <div className="run-progress-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="run-progress-label">
        {pct}% {run.currentTerm ? `· ${run.currentTerm}` : ''} {run.currentStep ? `· ${run.currentStep}` : ''}
      </div>

      {run.result != null && (
        <div className="run-log-section">
          <div className="run-log-title">Result</div>
          <pre className="json-preview" style={{ maxHeight: 'none' }}>
            {JSON.stringify(run.result, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
```

---

## Verification

### Build / typecheck

```bash
cd c:\Users\und3r\webscrape\src\WebScrape.Client
npm install
npm run typecheck
npm run build
```

All three must succeed with zero errors before any manual step.

### Manual end-to-end (drives parent spec M1.5 steps 3–16)

Pre-flight (already covered in `webscrape_local_dev.md`):

```powershell
& 'C:\Program Files\PostgreSQL\17\bin\pg_ctl.exe' start -D 'C:\Program Files\PostgreSQL\17\data' -l "$env:TEMP\pg_start.log" -w
```

```bash
cd c:\Users\und3r\webscrape && dotnet run --project src/WebScrape.Server
```

```bash
cd c:\Users\und3r\webscrape\src\WebScrape.Client && npm run dev
```

Then run M1.5 steps 3–16 verbatim from the parent spec, against `http://localhost:5173`.

### No automated frontend tests in M1.3

Per parent spec, frontend tests are deferred to the dev's hardening pass (M2+). `tsc --noEmit` is the only automated gate.

---

## Edge case decisions (for this scaffold only)

| Case | Decision |
|---|---|
| CSRF cookie missing on app boot | **Cover.** `ensureCsrfCookie()` runs before React mounts. |
| CSRF cookie cleared mid-session | **Ignore (v1).** User re-logs in; `/api/account/csrf` is idempotent and re-issues. |
| 401 from any endpoint | **Cover.** axios interceptor sets `['me']` to null; `AuthShell` redirects. |
| Worker goes offline between picker open and Run click | **Cover.** Backend returns 409 → modal shows the inline error message. |
| Run polling continues after navigating away | **Cover.** TanStack Query cancels via `enabled` and unmount. |
| Token modal closed without copying | **Ignore (v1).** Explicit copy button + warning copy. |
| Multiple tabs logged in | **No action.** Cookie is shared. |
| Backend not running | **Ignore (v1).** Pages render empty/loading; user retries. |
| Run row's `result` is huge | **Ignore (v1).** `<pre>` scrolls vertically; M3 will replace with structured cards. |
| Token contains characters that need URL-encoding | **N/A.** Token is `wsk_` + base64url chars; safe in headers and JSON. |

---

## Out of scope (do not add)

- Task creation / editing UI
- Block tree, CodeMirror
- Result charts/tables/cards
- Run history list
- Toast notifications
- Skeleton loaders, animations beyond what `index.css` already provides
- Dark mode
- Optimistic mutations
- Rate-limit-aware retries
- SignalR client
- i18n
- E2E (Playwright/Cypress) tests
- Vitest unit tests
- Accessibility audit beyond default semantic HTML

---

## Implementation order (suggested)

1. Tier-1 scaffold (`package.json` … `.gitignore`). `npm install`.
2. `src/index.css` — copy + append.
3. Tier-3 HTTP layer (`types.ts`, `client.ts`, `queries.ts`, `mutations.ts`).
4. Tier-2 shell (`main.tsx`, `App.tsx`).
5. Tier-4 components (`Sidebar.tsx`, `Modal.tsx`).
6. Tier-5 pages, in this order: `Login` → `Workers` → `ApiKeys` → `Tasks` → `RunDetail`.
7. `npm run typecheck` after each tier.
8. `npm run dev` and walk M1.5 steps 3–16.
