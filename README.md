# Image Cache

A lightweight redirect service for managing marketing images across holidayextras.com. Marketing can swap campaign images site-wide without code deploys, cache invalidations, or engineering help.

## How it works

The service manages **stable URLs** that redirect to **versioned image assets** on IMGIX.

```
Browser requests:
  https://www.holidayextras.com/image-cache/homepage-hero/wide

Service responds:
  302 → https://holidayextras.imgix.net/web/homepage/2026-06/summer-wide.avif
  Cache-Control: public, max-age=60, stale-while-revalidate=300
```

The HTML never changes — only the redirect target changes when marketing publishes a new campaign. IMGIX handles all image sizing, format conversion, and CDN delivery.

### Caching strategy

**Pointer URLs** (`/image-cache/homepage-hero/wide`) are cached briefly:
```
Cache-Control: public, max-age=60, stale-while-revalidate=300
```
Changes propagate within ~60 seconds. During `stale-while-revalidate`, browsers serve the old image while fetching the new one in the background.

**Final image URLs** on IMGIX use unique versioned filenames and are cached aggressively by IMGIX itself (`immutable`). No invalidation needed because new campaigns get new filenames.

## Endpoints

All routes live under `/image-cache` (configured via `BASE_PATH`).

### Public

| Endpoint | Description |
|---|---|
| `GET /image-cache/homepage-hero/wide` | 302 redirect to current wide hero image |
| `GET /image-cache/homepage-hero/narrow` | 302 redirect to current narrow hero image |
| `GET /image-cache/manifest.json` | JSON manifest of all current redirects |
| `GET /image-cache/health` | Health check |

### Admin (token-protected)

| Endpoint | Description |
|---|---|
| `GET /image-cache/admin?token=TOKEN` | Admin UI |
| `GET /image-cache/api/redirects` | List all redirects |
| `GET /image-cache/api/redirects/:id` | Get redirect with history |
| `POST /image-cache/api/redirects` | Create a new redirect |
| `PUT /image-cache/api/redirects/:id` | Update redirect target |
| `POST /image-cache/api/redirects/:id/rollback/:index` | Rollback to a previous version |
| `DELETE /image-cache/api/redirects/:id` | Delete a redirect |

Auth is via `?token=` query parameter or `X-Admin-Token` header.

## Admin UI

Access at `/image-cache/admin?token=TOKEN`. The admin lets marketing:

- **View** all current redirects grouped by section (homepage-hero, parking-hero, etc.)
- **Edit** any redirect's target URL with a change note
- **Rollback** to any previous version with one click
- **Copy** the full public URL to clipboard for pasting into page code
- **Create** new redirects for new page sections
- **Delete** redirects that are no longer needed

Every change records who made it, when, and why — full audit trail.

## Homepage integration

```html
<picture>
  <source
    media="(max-width: 767px)"
    srcset="https://www.holidayextras.com/image-cache/homepage-hero/narrow"
  >
  <source
    media="(min-width: 768px)"
    srcset="https://www.holidayextras.com/image-cache/homepage-hero/wide"
  >
  <img
    src="https://www.holidayextras.com/image-cache/homepage-hero/wide"
    alt="Holiday Extras"
    width="1600"
    height="700"
    loading="eager"
    fetchpriority="high"
  >
</picture>
```

## Local development

```bash
npm install
npm run dev
```

Opens on `http://localhost:3000`. Admin at `http://localhost:3000/admin?token=dev-token`.

Locally the service uses file-based JSON storage (`data/redirects.json`). No database needed for development.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server port |
| `ADMIN_TOKEN` | `dev-token` | Token for admin access |
| `BASE_PATH` | (empty) | URL prefix, e.g. `/image-cache` |
| `DATABASE_URL` | (none) | Postgres connection string. If set, uses Postgres for persistence instead of file-based JSON |

## Deployment

Hosted on Heroku EU with Postgres for persistence. Cloudflare routes `holidayextras.com/image-cache/*` to the Heroku app.

```bash
git push heroku main
```

### Infrastructure

- **Heroku**: `hx-image-cache` (EU region)
- **Database**: Heroku Postgres Essential-0
- **Routing**: Cloudflare path-based route at `/image-cache`

## Architecture

Redirect lookups are served from an in-memory hash map — no database or file I/O on the hot path. Postgres is only touched on admin writes and at boot (to hydrate the cache). The service handles thousands of redirects per second.

```
Request flow (public):
  Browser → Cloudflare → Heroku → in-memory lookup → 302 redirect → IMGIX

Request flow (admin write):
  Admin UI → Heroku → update Postgres + update in-memory cache
```
