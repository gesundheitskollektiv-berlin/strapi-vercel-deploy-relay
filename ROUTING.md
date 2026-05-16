# Routing rules (`strapi-vercel-deploy-relay`)

The relay examines **`event.body.uid`** (and **`event.body.entry`** for media). It never calls Strapi — only **`POST`**s to exactly one Deploy Hook URL from env.

References: [Strapi webhooks](https://docs.strapi.io/cms/backend-customization/webhooks), [Vercel deploy hooks](https://vercel.com/docs/deploy-hooks).

## Authenticated callers

Inbound requests must send:

```http
Authorization: Bearer <RELAYER_SHARED_SECRET>
```

Mismatch → **`401`** (no deploy hook invoked).

---

## Branch A — Content API types

**Regex (case-sensitive) on `uid`:**

```
^api::(kipra|geko|alpra)-
```

- Match → derive site from capture group `kipra` | `geko` | `alpra` → `POST` the matching **`VERCEL_DEPLOY_HOOK_<SITE>`** (upper env suffix).
- **Code does not enumerate types** — only this pattern.

Canonical content-type folders in this CMS (humans drift-check vs [`strapi/src/api`](../strapi/src/api)):

| Site | API folders |
|------|-------------|
| **kipra** | `kipra-announcement`, `kipra-material`, `kipra-meta`, `kipra-page-datenschutzerklaerung`, `kipra-page-impressum`, `kipra-page-landing`, `kipra-personnel` |
| **geko** | `geko-announcement`, `geko-announcement-tag`, `geko-cta`, `geko-material`, `geko-meta`, `geko-page-about`, `geko-page-angebote`, `geko-page-datenschutzerklaerung`, `geko-page-impressum`, `geko-page-kontakt`, `geko-page-landing`, `geko-page-support`, `geko-service`, `geko-supporter` |
| **alpra** | `alpra-announcement`, `alpra-material`, `alpra-meta`, `alpra-page-datenschutzerklaerung`, `alpra-page-impressum`, `alpra-page-landing`, `alpra-personnel` |

Example `uid` values: `api::kipra-meta.kipra-meta`, `api::geko-page-landing.geko-page-landing`.

---

## Branch B — Media Library (upload plugin)

**Plugin `uid`** (confirm on your Strapi 5 webhook sample; relay default):

```
plugin::upload.file
```

If `uid` matches that literal:

1. Build a **`/`**-joined folder path from **`entry.folder`** walking **`parent`** (null-safe): each node contributes **`name`** or **`slug`**, otherwise a trimmed **`path`** segment fallback.
2. **Regex on the assembled path** (case-insensitive), first-root segment:

   ```
   ^(kipra|geko|alpra)(/|$)
   ```

3. Match → same deploy hook mapping as branch A using the captured site (normalized to lowercase).
4. No path / no root match → **`skipped`** (no hook); **avoid wrong-site redeploy**.

### Editorial convention

Create **top-level Media Library folders** named **`kipra`**, **`geko`**, **`alpra`**. Nested folders are OK (`kipra/announcements/…`).

If Strapi sends **no populated folder chain** on the webhook, captured path may be empty → skipped. Inspect one real **`media.update`** payload and adjust **`folderPathFromEntry`** in `api/strapi-deploy.js` if field names differ (no Strapi repo change needed).

Optional later: env **`MEDIA_FANOUT=all`** — not implemented in v1.

---

## Branch C — Anything else

`plugin::users-permissions.*`, unrelated plugins → **skipped**, no hook.

---

## Responses (summary)

| Case | HTTP | Body |
|------|------|------|
| Not `POST` | 405 | `{ "error": "Method Not Allowed" }` |
| Bad secret | 401 | `{ "error": "Unauthorized" }` |
| Invalid JSON | 400 | `{ "error": "Invalid JSON body" }` |
| Routed + hook OK | 200 | `{ "ok": true, "site", "reason", ...hookMeta }` |
| Routed + hook upstream error | 502 | `{ "ok": false, "site", ... }` |
| Skipped | 200 | `{ "ok": true, "skipped": true, "reason" }` |
