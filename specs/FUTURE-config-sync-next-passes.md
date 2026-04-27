# FUTURE: Config Sync — Next Passes

**Status:** Parked. Not scheduled.

**Purpose:** Capture deferrals from the M5.2 config-sync bug-fix pass (planned 2026-04-26) so we don't lose them when the work resumes. Each item below was considered during that pass, agreed as out-of-scope for the immediate fix, and is parked here for a future round.

**Context:** The current pass closes acute bugs — duplicate creation on rapid sync clicks, stale React state, lost-on-edit `shared` flag, missing auto-push, no server→extension propagation while sidepanel is open, server-side de-dup defence. See `SPEC-M5.2-config-sync-fixes-v1.0.md` for the implementation spec of that round. This file captures everything we deliberately *didn't* fix.

---

## A. Real-time propagation (SignalR)

**Problem.** Today extensions only learn about server-side config changes via pull (manual button, visibility-change, or reconnect). The spec mentioned auto-push from backend to extensions but it was never wired up. Acceptable for the typical "edit on web → switch to extension" flow because the focus switch IS the trigger. Unacceptable when seconds matter (multi-worker concurrent editing, mid-batch config tweaks).

**Agreed design.**

- New SignalR hub method on `user:{userId}` group: `ConfigUpdated(ScraperConfigDto)`, `ConfigDeleted(Guid)`, `SubscriberChanged(Guid configId, int onlineCount)`.
- Server invokes from `ScraperConfigsController.Create`/`Update`/`Delete` after `SaveChangesAsync` succeeds.
- Offscreen relays to sidepanel via existing message bus.
- Sidepanel calls a new `useSyncStore.refreshOne(id)` that fetches just that config (`GET /api/scraper-configs/{id}`) and merges into local storage.
- Race handling: if the local config is `dirty`, the incoming push becomes a conflict (same modal as today).

**Why this is its own pass:** server hub method, controller plumbing, extension message type, offscreen relay, sidepanel handler, conflict path — six discrete touchpoints, each with its own test surface.

---

## B. Backend frontend polish

### B.1 Enrich the Sync column

**Problem.** After the M5.2 fix the column will show "Synced" correctly, but it carries no information: subscriber count, origin worker name, last-synced relative time would all help.

**Agreed design.**

- New endpoint `GET /api/scraper-configs/subscribers-summary` returning `{ configId, onlineCount, totalCount, lastPulledAt }[]` for all configs the user owns. One query instead of N.
- `Configs.tsx` Sync column shows: "Synced · 2 extensions" (badge with count), tooltip with names and last pull times.
- `originWorkerName` already in `ScraperConfigDto` — surface as a sub-line under the Name column ("Imported from <worker>") if not already shown.

### B.2 Conflict UX for cookie-auth editors

**Problem.** Cookie auth bypasses `If-Match` entirely (`ScraperConfigsController.cs:59`). Two browser tabs editing the same config: second save silently clobbers. Same vulnerability if a backend user edits while an extension is mid-push.

**Agreed design.**

- Apply `If-Match` to cookie auth too, sourced from the editor's hydration timestamp.
- On 412, show a diff modal (port the extension's `ConfigConflictDiffModal` pattern).
- Or: simpler interim — show a "this config was edited X seconds ago by Y" banner that polls every 10s while the editor is open.

### B.3 Stop-sharing warning when subscribers exist

**Problem.** The new "Share with my extensions" checkbox in the editor (added in M5.2 fix pass) toggles silently. If subscribers are connected, they should know.

**Agreed design.**

- When toggling the checkbox off and `onlineSubscribers > 0`, show a confirm modal: "N extension(s) are currently syncing this config. They'll keep their local copy but stop receiving updates."
- Pattern matches existing `Modal` + `confirmDelete` flow.

### B.4 Preserve `originWorkerName` on cookie edits

**Problem.** `originClientId` is only set by PAT requests on first share. Cookie-auth `Update` doesn't touch it, which is correct — but if an admin recreates a config via cookie auth (new ID), the "Imported from X" lineage is lost. Minor, but worth flagging.

**Agreed design.**

- Treat `OriginClientId` as immutable once set. (Already mostly the case — explicit comment, plus a unit test pinning the behaviour.)

---

## C. Extension UX

### C.1 Multi-extension propagation gap

**Problem.** Pull-on-visibility (M5.2) handles "edit on web → switch to extension". It does NOT handle "edit on extension A → see in extension B" until B is opened/focused. Edge case (one user, two browsers/profiles) but real.

**Agreed design.** Subsumed by item A (SignalR push). No separate work.

### C.2 Periodic background sync

**Problem.** A user with the sidepanel open all day, never refocusing, never editing — won't see server-side changes until they touch something.

**Agreed design.**

- Interval timer in sidepanel (e.g. every 5 min) calling `pullSharedConfigs` while connected.
- Clamp by visibility: don't poll while hidden (cheap insurance, no battery cost).
- Cancellable; respects the in-flight guard from M5.2.

### C.3 `chrome.storage.onChanged` listener in `ConfigList`

**Problem.** The version-counter signal added in M5.2 only bumps from sync ops. If a future code path writes to `chrome.storage.local` directly (e.g. a service-worker-driven import), the list won't refresh.

**Agreed design.**

- `ConfigList` adds a `chrome.storage.onChanged` listener filtered to the configs key. Re-fetches on change.
- Keep the version-counter for cheap manual triggers.

### C.4 Surface pull errors

**Problem.** `useSyncStore.lastSyncError` is set but never displayed. Silent failure mode.

**Agreed design.**

- Subtle inline banner near the new pull button (existing `.danger-banner` style) when `lastSyncError` is non-null. Auto-clears on next successful pull.
- Optional toast on first occurrence within a session.

### C.5 Conflict entry point from `ConfigSyncStatus`

**Problem.** `pullSharedConfigs` can populate `useSyncStore.conflicts` for a config the user isn't currently looking at. The per-row badge shows "Conflict" but currently only the per-card sync button opens the diff modal — the badge itself isn't clickable.

**Agreed design.**

- Make `ConfigSyncStatus` clickable when in conflict — opens the same `ConfigConflictDiffModal`.

---

## D. Server hardening

### D.1 Strict duplicate POST → 409

**Problem.** M5.2 makes POST idempotent on `(userId, suggestedId)` when name+domain+configJson all match — silent reuse. If they don't match, returns 409. Once the client is robust, the silent-reuse path becomes lazy: we could move to "always 409 on collision; client must reconcile."

**Agreed design.**

- Replace the conservative match check with unconditional 409 on `(userId, suggestedId)` collision.
- Client reads the existing entity from the 409 body and decides: PUT (overwrite), conflict modal, or rename.

### D.2 Patch model for partial updates

**Problem.** Today PUT replaces every field. The `shared` flag bug (M5.2) was a symptom — a partial-update model would have prevented it structurally.

**Agreed design.**

- New `PATCH /api/scraper-configs/{id}` accepting only the fields the caller wants to change.
- DTO with all-nullable fields; `null` means "don't touch."
- Existing PUT stays for full-replace semantics (extension's PUT after a conflict resolution).

### D.3 One-shot dedup migration

**Problem.** The duplicates created during the M5.2 incident exist in your DB. M5.2 ships with manual-cleanup-via-frontend as the recommended path; that's fine at current scale.

**Agreed design.** Only worth scoping if the duplicate problem recurs at scale, OR if a customer hits it with hundreds of rows. Sketch: migration that groups by `(userId, name, domain)`, keeps the row with the most subscribers (or latest `UpdatedAt`), deletes the rest, rewrites any `RunBatch` references via `ScrapeBlockConfigDto.scraperConfigId` lookup.

---

## E. Refactors / debt

### E.1 Move sidepanel configs into a dedicated zustand store

**Problem.** `ConfigList` re-fetches from `chrome.storage.local`; `ConfigEditor` works off `useConfigStore`. Two sources of truth. The version-counter workaround in M5.2 papers over this — it doesn't fix it.

**Agreed design.**

- New `useConfigsStore` holding the full list, hydrated once from `chrome.storage.local`, kept in sync via a single write path.
- All readers (`ConfigList`, `ConfigEditor`, sync store) go through it.
- `chrome.storage.onChanged` re-hydrates when external writes happen.
- Removes the entire "stale React state" class of bugs.

**Why deferred:** touches every component that reads configs. Low-risk per touch but high blast radius.

### E.2 Concurrency guard on `pullSharedConfigs`

**Problem.** No guard against overlapping calls. With visibility-pull + reconnect-pull + manual button (all from M5.2), overlap becomes more likely.

**Agreed design.**

- `if (get().syncing) return;` at the top of `pullSharedConfigs`.
- Or: queue subsequent calls and coalesce — only useful if we discover the simple guard drops user-meaningful triggers.

### E.3 Audit `pushIfDirty`'s "different ID" deletion path

**Problem.** Once D (server-side `(userId, suggestedId)` idempotency from M5.2) is in, the "server assigned a different ID, delete the old local entry" branch (`syncStore.ts:95-98`) only fires on cross-user GUID collision (≈ never).

**Agreed design.**

- Either remove the branch and rely on idempotency, OR document explicitly so it doesn't get cargo-culted.
- Deferred because removing requires confidence the idempotency contract holds — leave for one release after M5.2.

### E.4 Remove `saveSharedConfig` alias

**Problem.** `storage.ts:94-96` is `return saveConfig(config)` — unused alias.

**Agreed design.** Grep for callers; delete if none.

---

## F. Out of scope but worth flagging

### F.1 Multi-user shared configs

**Problem.** All sync is `userId`-scoped. Configs aren't shareable across team members. A second user on the same backend has no way to use the first user's configs.

**Agreed direction (not designed):**

- Org-scoped configs with read/write permissions.
- Probably involves an `organizations` table, `user_organizations` join, and an `organization_id` column on configs (nullable to keep personal configs).

### F.2 Versioned config history

**Problem.** Edits are destructive. If an edit breaks scraping mid-batch, the user can't revert.

**Agreed direction (not designed):**

- Keep N past `configJson` blobs per config (e.g. last 10).
- Show in editor as a "history" dropdown; one-click revert creates a new edit.

---

## Index of items by area

- **Real-time push:** A
- **Backend frontend:** B.1 (column enrichment), B.2 (cookie conflict UX), B.3 (stop-sharing warning), B.4 (origin worker)
- **Extension:** C.1 (subsumed by A), C.2 (periodic sync), C.3 (storage listener), C.4 (error surfacing), C.5 (conflict click target)
- **Server:** D.1 (strict 409), D.2 (patch model), D.3 (dedup migration)
- **Debt:** E.1 (configs store), E.2 (concurrency guard), E.3 (audit path), E.4 (alias)
- **Future-future:** F.1 (multi-user), F.2 (history)
