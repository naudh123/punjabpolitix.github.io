# Host www.punjabpolitix.com on Vercel

Move the static site from **GitHub Pages** to **Vercel**. The repo root is the site (`index.html`, `rajneetios/`, etc.).

## 1. Create the Vercel project

1. [vercel.com](https://vercel.com) → **Add New** → **Project** → import **`punjabpolitix/punjabpolitix.github.io`** (or your fork).
2. **Framework Preset:** Other  
3. **Root Directory:** `.` (repo root)  
4. **Build Command:** leave empty  
5. **Output Directory:** leave empty (static files at root)  
6. Deploy once (preview URL should show the marketing home page).

`vercel.json` in the repo sets `framework: null` and long cache headers for Admin UI assets.

## 2. Custom domain

1. Vercel project → **Settings** → **Domains** → add:
   - `www.punjabpolitix.com`
   - `punjabpolitix.com` (redirect to www if you prefer)
2. At your DNS host, point the domain to Vercel (replace GitHub Pages records):
   - **A** `76.76.21.21` for apex `punjabpolitix.com`, **or**
   - **CNAME** `cname.vercel-dns.com` for `www` (Vercel shows the exact values).
3. GitHub repo → **Settings** → **Pages** → remove custom domain `www.punjabpolitix.com` so only Vercel serves it.
4. Optional: delete root **`CNAME`** file from git after cutover (GitHub Pages used it; Vercel uses dashboard DNS).

Wait for SSL (automatic on Vercel).

## 3. RajneetiOS Admin UI

Built files live at **`rajneetios/Admin/`** (from `rajneetOS`):

```powershell
cd C:\RentIt_Dev\apps\rajneetios\rajneetOS
.\scripts\deploy_admin_ui_to_politix_pages.ps1
# commit + push punjabpolitix.github.io → Vercel redeploys
```

Open: `https://www.punjabpolitix.com/rajneetios/Admin/#/sysadmin`

## 4. Admin API (ingest uploads)

Vercel serves **static files only**. FastAPI (`admin_ingest_api.py`) must run elsewhere (Cloud Run, VM, Railway, etc.).

### Option A — Same-origin proxy (recommended on Vercel)

Proxy `/api`, `/health`, `/docs` through Vercel to your API host:

1. Set `ADMIN_API_ORIGIN` (no trailing slash), e.g. `https://rajneetos-admin-xxxxx.run.app`
2. From `rajneetOS`:

   ```powershell
   $env:ADMIN_API_ORIGIN = "https://YOUR-API-HOST"
   .\scripts\generate_vercel_config.ps1 -PolitixRepo "C:\RentIt_Dev\punjabpolitix.github.io"
   ```

3. Commit `vercel.json`, push, redeploy.
4. Rebuild Admin UI **without** `VITE_ADMIN_API_URL` (browser uses `/api` on the same domain).
5. On the API server:

   ```text
   ADMIN_API_CORS_ORIGINS=https://www.punjabpolitix.com,https://punjabpolitix.com
   ```

   (CORS is still needed if anything calls the API URL directly.)

### Option B — Direct API URL

Build Admin UI with:

```text
VITE_ADMIN_API_URL=https://YOUR-API-HOST
```

and CORS on the API. No `vercel.json` rewrites required.

## 5. Store Incharge (Firebase)

`rajneetios/store-incharge/` is unchanged. In Google Cloud → Credentials, add Vercel origins to Firebase Web API key HTTP referrers if you change domain setup (same hostname `www.punjabpolitix.com` → usually no change).

## Checklist

- [ ] Vercel project deployed from `punjabpolitix.github.io`
- [ ] DNS points to Vercel; GitHub Pages custom domain removed
- [ ] `rajneetios/Admin` present after deploy script + push
- [ ] Admin API hosted + proxy or `VITE_ADMIN_API_URL` + CORS
- [ ] Sysadmin sign-in works on production
