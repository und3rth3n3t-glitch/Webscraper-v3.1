# SPEC — Config Conflict Banner v1.0

**Version:** 1.0
**Status:** Ready for implementation (Sonnet)
**Related:** Supersedes the deferred item C.5 in `specs/FUTURE-config-sync-next-passes.md`. Does not address items A (SignalR push), B.2 (cookie-auth If-Match), or C.4 (surface pull errors) — those remain parked.

---

## Context

A user edits a shared scraper config in the React backend frontend; the extension's local copy is also `dirty: true` from a prior in-extension save. On the next pull (manual button, sidepanel re-focus, or reconnect) the sync store flags a conflict in `useSyncStore.conflicts[configId]`. The current UX surfaces this conflict in two places:

1. A non-clickable "Conflict" pill rendered by `ConfigSyncStatus` inside the config card body.
2. The WiFi share-toggle icon, which is overloaded — when `inConflict` it opens the diff modal instead of toggling sharing.

Both are bad: the pill looks like a status label (no affordance), and the WiFi icon's behaviour silently changing when in conflict is confusing — users hover, see "Server has newer changes", and don't realise the icon they're looking at is the click target.

This spec replaces both with a single discoverable inline banner inside the config card. The WiFi icon goes back to being **only** a share toggle and is disabled while a conflict exists. The `ConfigConflictDiffModal` component itself is unchanged — only its entry point changes.

### What we're not building

- Real-time SignalR push from server → extension (FUTURE A).
- `If-Match` enforcement for cookie-auth saves on the React frontend (FUTURE B.2).
- Surfacing `lastSyncError` (FUTURE C.4).
- Clickable `ConfigSyncStatus` badge (FUTURE C.5) — superseded by the banner.
- Investigating whether the WiFi-icon resolve path was actually broken in the past — out of scope; we're removing it regardless.

---

## Files changed

| File | Change |
|---|---|
| `src/sidepanel/styles/index.css` | Add `.detection-banner--error` modifier (5 lines) |
| `src/sidepanel/components/ConfigSyncStatus.tsx` | Return `null` when `inConflict`; drop the conflict branch from the render logic |
| `src/sidepanel/components/ConfigListItem.tsx` | Render conflict banner; remove WiFi-icon overload; disable WiFi icon while in conflict |

No new files. No deletions. No test file changes (existing `syncStore.test.ts` still covers `resolveConflict`).

---

## Implementation

### Change 1 — `src/sidepanel/styles/index.css`

**What:** Add an `--error` modifier alongside the existing `--warning` modifier so the banner can be styled red without using legacy `.detection-banner.error` form.

**Where:** Insert immediately after the closing `}` of `.detection-banner--warning` (currently ends at line 481), before the `/* ===== Tooltips ===== */` comment at line 483.

**Edit (use `Edit` tool):**

`old_string`:
```css
/* V3 new modifier */
.detection-banner--warning {
  background: var(--warning-light);
  border-color: var(--warning);
  color: var(--text-dark);
}

/* ===== Tooltips ===== */
```

`new_string`:
```css
/* V3 new modifier */
.detection-banner--warning {
  background: var(--warning-light);
  border-color: var(--warning);
  color: var(--text-dark);
}

.detection-banner--error {
  background: var(--danger-light);
  border-color: var(--danger);
  color: var(--text-dark);
}

/* ===== Tooltips ===== */
```

### Change 2 — `src/sidepanel/components/ConfigSyncStatus.tsx`

**What:** When the config is in conflict, return `null` so the banner in `ConfigListItem` is the only conflict surface. Drop the now-unreachable `if (inConflict)` branch and the now-redundant `&& !inConflict` guard.

**How:** This file is short (45 lines). Replace its full contents.

**Full new contents:**

```tsx
import { useSyncStore } from '../stores/syncStore';
import type { ScraperConfig } from '../../types/config';

interface Props {
  config: ScraperConfig;
}

export default function ConfigSyncStatus({ config }: Props) {
  const { syncing, conflicts, pushingIds } = useSyncStore();

  if (!config.shared) return null;

  const inConflict = !!conflicts[config.id];
  // Conflict UX is owned by ConfigListItem's banner — this component renders nothing in that state.
  if (inConflict) return null;

  const isPending = config.dirty;
  const isPushing = pushingIds.has(config.id);
  const isSyncing = isPushing || (syncing && isPending);

  let dot: string;
  let label: string;

  if (isSyncing) {
    dot = 'running';
    label = 'Syncing…';
  } else if (isPending) {
    dot = 'pending';
    label = 'Pending sync';
  } else {
    dot = 'success';
    label = 'Synced with backend';
  }

  return (
    <span
      className="meta-badge"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
      title={label}
    >
      <span className={`status-dot ${dot}`} />
      {isPending ? 'Pending' : 'Synced'}
    </span>
  );
}
```

**Notes for the implementer:**

- The single comment retained is the `inConflict` early-return rationale — it's a non-obvious cross-component coordination, fits the project's "comment only the WHY" rule.
- All other behaviour (pending/syncing/synced) is byte-for-byte identical; only the conflict path is removed.

### Change 3 — `src/sidepanel/components/ConfigListItem.tsx`

Three edits to this file.

#### 3a. Remove conflict overload from the WiFi icon button

`old_string`:
```tsx
            <button
              className={`btn btn-icon ${config.shared ? 'btn-icon-edit' : 'btn-icon-subtle'}`}
              onClick={inConflict ? () => setConflictOpen(true) : handleToggleShare}
              disabled={isPushing}
              title={
                isPushing
                  ? 'Syncing…'
                  : inConflict
                  ? 'Server has newer changes — click to resolve'
                  : config.shared
                  ? 'Stop syncing (your backend keeps a copy)'
                  : 'Sync this config with your backend'
              }
              aria-label={config.shared ? 'Stop syncing' : 'Sync config'}
            >
              {config.shared ? <Wifi size={14} /> : <WifiOff size={14} />}
            </button>
```

`new_string`:
```tsx
            <button
              className={`btn btn-icon ${config.shared ? 'btn-icon-edit' : 'btn-icon-subtle'}`}
              onClick={handleToggleShare}
              disabled={isPushing || inConflict}
              title={
                isPushing
                  ? 'Syncing…'
                  : inConflict
                  ? 'Resolve the conflict first'
                  : config.shared
                  ? 'Stop syncing (your backend keeps a copy)'
                  : 'Sync this config with your backend'
              }
              aria-label={config.shared ? 'Stop syncing' : 'Sync config'}
            >
              {config.shared ? <Wifi size={14} /> : <WifiOff size={14} />}
            </button>
```

#### 3b. Replace the sync-status block with conditional sync-status / conflict banner

`old_string`:
```tsx
        {config.shared && (
          <div className="config-card-body" style={{ paddingTop: 0 }}>
            <ConfigSyncStatus config={config} />
          </div>
        )}
```

`new_string`:
```tsx
        {config.shared && !inConflict && (
          <div className="config-card-body" style={{ paddingTop: 0 }}>
            <ConfigSyncStatus config={config} />
          </div>
        )}

        {config.shared && inConflict && (
          <div className="config-card-body" style={{ paddingTop: 0 }}>
            <div className="detection-banner detection-banner--error">
              <div className="detection-banner-body">
                <strong>Backend has newer changes</strong>
                <p>You edited this here, but it was also edited on the backend. Pick which version to keep.</p>
              </div>
              <button className="btn btn-secondary btn-sm" onClick={() => setConflictOpen(true)}>
                Resolve
              </button>
            </div>
          </div>
        )}
```

#### 3c. Final file order check (no edit, just verification)

After 3a + 3b, confirm by reading the file that:

1. Imports at the top are unchanged (no new icons needed; `Wifi`/`WifiOff` still imported and used).
2. `conflictOpen` state and `setConflictOpen` are still declared (used by the new banner button — line 24 in the original, no change needed).
3. `inConflict` is still derived on line ~31 (`const inConflict = !!conflicts[config.id];`) — no change.
4. `<ConfigConflictDiffModal>` render block at the bottom is unchanged.

If any of those four are missing or moved, stop and report — do not improvise.

---

## Verification

### Automated

Run from `c:\Users\und3r\blueberry-v3`:

```bash
npm run lint
npx vitest run
```

Expected: lint clean, all tests pass. No test changes are required — existing `src/__tests__/syncStore.test.ts` already covers `pullSharedConfigs` conflict population, `pushIfDirty` 412 → conflict, and `resolveConflict('mine'|'theirs')`. Those code paths are unchanged.

If any test fails, **stop**. Report the failure verbatim — do not edit tests to make them pass.

### Manual repro (extension UX)

Prerequisite: backend running, extension built and loaded, sidepanel signed in and connected.

1. **Make a config dirty in the extension.** In the extension's Config tab, open or build a config with `Share with backend` enabled and click Save. Confirm in DevTools console:
   ```js
   chrome.storage.local.get(null, r => console.log(r.scraperConfigs?.find(c => c.shared && c.dirty)))
   ```
   Should show one with `dirty: true`.
2. **Edit the same config in the React app.** Open the backend frontend, navigate to the synced config, change the domain (any change), Save. Confirm `UpdatedAt` advances on the server (check the row in the React Configs list — the date column should update).
3. **Trigger a pull in the extension.** Switch to the sidepanel tab; the visibility-change pull fires. Or click the manual pull button.
4. **Banner check:**
   - Conflict banner renders inside the affected config card.
   - Background is `var(--danger-light)`, left border red.
   - Title: "Backend has newer changes" — bold.
   - Body: "You edited this here, but it was also edited on the backend. Pick which version to keep."
   - "Resolve" button on the right (secondary style, sm size).
   - The previous "Conflict" pill is **gone** — banner is the only indicator.
5. **WiFi icon check while in conflict:**
   - Icon is visibly disabled.
   - Hover shows "Resolve the conflict first".
   - Clicking does nothing (button is disabled).
6. **Resolve via banner — backend wins:**
   - Click "Resolve" → `ConfigConflictDiffModal` opens with both versions side by side.
   - Click "Keep backend version" → modal closes, banner disappears, `ConfigSyncStatus` returns to "Synced".
   - Confirm `dirty: false` and `lastSyncedAt` matches the server's `UpdatedAt` in storage.
7. **Resolve via banner — local wins:** Repeat steps 1–3 to re-create the conflict, click Resolve → "Keep my version" → banner disappears, server `UpdatedAt` advances, extension shows "Synced" with the user's local content.
8. **Multi-conflict layout:** Repeat steps 1–3 with two different configs simultaneously. Both cards should show their own banner; resolving one does not affect the other.

### Edge cases — covered

- **WiFi icon disabled during conflict.** Covered by `disabled={isPushing || inConflict}` in 3a.
- **Multiple configs in conflict simultaneously.** Covered — each card derives `inConflict` from its own `conflicts[config.id]` lookup.
- **Banner appears for `!config.shared`.** Cannot happen — guarded by `config.shared && inConflict` in 3b. (`conflicts` only populates for shared configs, but the guard belt-and-braces the case where someone toggles share off mid-conflict.)

### Edge cases — ignored (with rationale)

- **Conflict cleared from another tab while modal open.** Ignore (v1) — `ConfigConflictDiffModal` already short-circuits via `if (!cs) return null` on line 15. No new failure mode introduced.
- **`pushingIds` stuck (push hung indefinitely).** Ignore (v1) — pre-existing risk, not regressed by this change. WiFi icon would be disabled too long; user can reload the sidepanel.
- **Banner flashes briefly during push attempt that returns 412.** Ignore (v1) — by the time the banner appears the conflict is real and stays until the user resolves it. No flicker risk.

---

## File order after changes

`ConfigListItem.tsx` (rendered top to bottom inside `<div className="list-card config-card">`):

1. `<div className="config-card-header">` — name + icon row (Duplicate, Edit, **WiFi (share-only)**, Delete).
2. `{config.domain && ...}` — domain badge.
3. `{config.shared && !inConflict && ...}` — `ConfigSyncStatus` block.
4. `{config.shared && inConflict && ...}` — **NEW** conflict banner.
5. `<div className="config-card-footer">` — step count, date, Run button.

Then outside the card:

- `<ConfirmDialog>` for delete (unchanged).
- `<ConfigConflictDiffModal>` for conflict resolution (unchanged — still opened via `conflictOpen` state).

---

## Done definition

- [ ] `npm run lint` clean.
- [ ] `npx vitest run` all green.
- [ ] Manual repro steps 1–8 all pass.
- [ ] No new files. No deleted files. No test file edits.
- [ ] Three files modified: `index.css`, `ConfigSyncStatus.tsx`, `ConfigListItem.tsx`.
