# Strapi deploy hook relay

Minimal Vercel serverless app: accepts **authenticated `POST`** webhooks carrying Strapi-shaped JSON (`uid`, optionally `entry`) and **`POST`**s at most one **[Vercel deploy hook](https://vercel.com/docs/deploy-hooks)** for **kipra-frontend**, **geko-frontend**, or **alpra-frontend**.

Routing rules & media conventions: **[ROUTING.md](./ROUTING.md)**.

## Deploy on Vercel

1. Create a new Vercel project rooted at **`strapi-vercel-deploy-relay/`** (or import this subfolder via monorepo “Root Directory”).
2. Set environment variables (**Settings → Environment Variables**), mirroring [.env.example](./.env.example):
   - `RELAYER_SHARED_SECRET`
   - `VERCEL_DEPLOY_HOOK_KIPRA`, `VERCEL_DEPLOY_HOOK_GEKO`, `VERCEL_DEPLOY_HOOK_ALPRA`
3. Deploy. The HTTPS endpoint will be **`https://<your-deployment>/api/strapi-deploy`**.

Point Strapi webhooks at that URL and send header **`Authorization: Bearer <RELAYER_SHARED_SECRET>`**.

## Local check

Requires [Vercel CLI](https://vercel.com/docs/cli):

```bash
cd strapi-vercel-deploy-relay
vercel env pull .env.local
vercel dev
# POST http://localhost:3000/api/strapi-deploy
```

## Files

| Path | Purpose |
|------|---------|
| `api/strapi-deploy.js` | Node serverless handler |
| `ROUTING.md` | `uid`/media routing spec |
