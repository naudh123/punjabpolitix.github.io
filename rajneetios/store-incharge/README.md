# Store Incharge demand queue — `field_web_store/`

Minimal browser stub for the **AC-level Store Incharge** to drive material-demand fulfilment for the pilot. Pairs with:

- **`firebase/firestore.rules`** §demands — state-machine enforcement and `ac_admin` / `super_admin` role bypass.
- **`field_app_android`** — booth-incharge create/list surface (`draft` / `submitted`).
- **`docs/FIRESTORE_SCHEMA_V0.md`** §3.3 — schema, status enum, transition spec.

## Why this is a stub

- **No build step** (vanilla HTML + ES-module Firebase Web SDK via CDN). Trivial to host on any static server (`python -m http.server`, GitHub Pages, Firebase Hosting).
- Two query modes: **this booth** (`collection(...)`) and **AC-wide** (`collectionGroup('demands')` with `where contractId / acCode` + `orderBy createdAt desc`; requires the composite index in `firebase/firestore.indexes.json`).
- Email/password auth only.
- **Status-filter chips** (`open` / individual statuses / `all`) toggle the active query. Single named status uses `where status == X` server-side (composite index); `open` and `all` fall back to client-side filtering of the snapshot.
- **Dispatch proof upload**: each demand row has a per-file upload form. Files are written to `gs://<bucket>/dispatch-proof/{contractId}/{cycleId}/{acCode}/{boothCode}/{demandId}/{ts}_{name}` (`image/*` only, ≤ 5 MiB; Cloud Storage Rules in `firebase/storage.rules`). The resulting path is appended to the demand's `dispatchProofRefs` array via `arrayUnion`; Firestore Rules cap the array at 10 entries.

Server-side state machine in `firebase/firestore.rules` is the source of truth; this UI only narrows the operator's choices.

## Prerequisites

- A Firebase project (the same one your Booth Incharge Android app and `field_bff` write to).
- Web app registered in Firebase Console → Project settings → General → Your apps → Web.
- One user with custom claims `role = ac_admin` (or `super_admin`) + `contractId` + `acCodes`. Mint with:

```powershell
.\scripts\set_booth_incharge_claims.ps1 -Uid <user-uid> -ContractId pilot -AcCodes 114 -Role ac_admin
```

- Firestore rules deployed (`firebase deploy --only firestore:rules`).
- Cloud Storage rules deployed (`firebase deploy --only storage`). Storage must be enabled on the Firebase project (Storage tab in Console → "Get started"); the default bucket is used.

## Run locally

1. Copy `firebase-config.example.js` → `firebase-config.js` and fill in `apiKey`, `authDomain`, `projectId`, `appId` from Firebase Console.
2. Serve the folder via any static server. Examples:

   ```powershell
   # Python (built-in)
   python -m http.server 5050 --directory field_web_store
   # then open http://127.0.0.1:5050/
   ```

   ```powershell
   # Node serve
   npx serve field_web_store -l 5050
   ```

3. Sign in with the email/password of the Store Incharge user.
4. Fill `contractId` / `cycleId` / `acCode` (pre-filled from claims when available). For the booth view also fill `boothCode`.
5. Click **Load this booth** or **Load all booths in this AC** (AC-wide uses `collectionGroup('demands')` with `where contractId == … and acCode == …` plus `orderBy createdAt desc`).
6. For each demand, the dropdown only shows transitions allowed by the state machine. Optionally enter `fulfilledQty` (validated `≤ quantity`) and a free-text reason / note. Click **Save**. The rules independently re-validate the transition, the `updatedBy = auth.uid` audit field, the fulfilled-qty cap, and the free-text length limits.

If the AC-wide query returns `FAILED_PRECONDITION`, deploy the composite index that ships in `firebase/firestore.indexes.json`:

```bash
firebase deploy --only firestore:indexes
```

## State machine (mirrors FUTURE_PLANNING §1.7 and `firebase/firestore.rules`)

```
draft               → submitted | cancelled
submitted           → in_progress | on_hold | rejected | cancelled
in_progress         → on_hold | partially_fulfilled | fulfilled | rejected | cancelled
on_hold             → in_progress | rejected | cancelled
partially_fulfilled → in_progress | fulfilled | cancelled
fulfilled           → (terminal)
rejected            → (terminal)
cancelled           → (terminal)
```

The exact adjacency list lives in `app.js`'s `TRANSITIONS` constant **and** in `firebase/firestore.rules` → `validDemandStatusTransition()`. Both sources are exercised by `firebase/rules-tests/firestore.test.mjs`.

## Limitations

- No `collectionGroup` queries on `dispatchProofRefs` themselves — proofs are reached via the parent demand doc.
- No bulk operations (e.g. "mark all matching submitted as in_progress"). Per-row only.
- No CI/lint pipeline for this folder; treat as throwaway scaffolding until a later slice formalises it.

## Deployment

For pilot day, the simplest path is Firebase Hosting:

```bash
firebase init hosting          # one-time per workspace; pick `field_web_store` as public dir
firebase deploy --only hosting
```

Or any static-file host. The app only talks to Firebase Auth + Firestore over HTTPS; nothing else.
