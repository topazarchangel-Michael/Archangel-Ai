# Archangel AI backend

Node 22 + TypeScript + [Hono](https://hono.dev) + SQLite (better-sqlite3). It holds any AI keys server-side and handles:

| Area | Endpoints |
| --- | --- |
| Health | `GET /health` |
| Auth (bcrypt + JWT, 30-day tokens) | `POST /auth/signup` `{email,password,name,inviteCode?}`, `POST /auth/login` |
| Account | `GET /me`, `DELETE /me` (deletes the user, profile, chats, creations, reports and image files) |
| AI profile | `GET /profile`, `PUT /profile` `{profile}` |
| Chat proxy | `POST /chat` `{messages:[{role,text}], profile?, mode?: "chat" or "writing"}` returns `{reply}` |
| Chats | `GET /chats`, `PUT /chats/:id` `{title,messages}` |
| Images | `POST /images` `{prompt}`: the `IMAGE_PROVIDER` (Pollinations free or xAI), saved as a creation and served from `/files/<uuid>.(png or jpg)` |
| Creations | `GET /creations`, `POST /creations` (writing), `DELETE /creations/:id` |
| Reports | `POST /reports` (a single report or `{reports:[...]}`) |

Everything except `/health`, `/auth/*` and `/files/*` needs `Authorization: Bearer <jwt>`.

**Errors** are always `{error:{code,message}}`, and the message is safe to show users. AI failures map to friendly codes: `ai_no_credits` (402), `ai_rate_limited` (429), `ai_bad_key`, `ai_upstream_down`, `ai_content_blocked`, `ai_not_configured`.

**Limits:**
- 256 KB max request body.
- Per-user rate limits: chat 20/min, images 10/hour (both configurable), auth 10/min per IP. The limiter is in-memory, so use Redis if you run more than one instance.
- Message, profile and report fields are length-capped.

**Tester invites:**
- `INVITE_CODES` is a comma-separated list (default `ARCHANGEL-TEST`).
- An invite code is optional on sign-up. A valid one marks the user as a tester; an invalid one is rejected.
- Set `REQUIRE_INVITE=true` to make a code mandatory.

## AI providers (free setup)
`CHAT_PROVIDERS` is an ordered fallback chain. The first provider that answers wins.

| Provider | Needs | Notes |
| --- | --- | --- |
| `pollinations` | nothing (keyless legacy `text.pollinations.ai`) | **Current default.** Good quality, about 6–13 s per reply. Best-effort: anonymous use is rate-limited (occasional 402/429, retried once after 4 s), and Pollinations' docs now push keys (`POLLINATIONS_API_KEY`, free signup at enter.pollinations.ai), so keyless access could end. |
| `ollama` | local Ollama at `OLLAMA_URL` | No signup, fully offline. On this CPU-only box `archangel-qwen2.5-1.5b` takes about 40 s per reply under load and quality is basic. Last-resort fallback. |
| `openai_compat` | `OPENAI_COMPAT_BASE_URL` / `_API_KEY` / `_MODEL` | Any OpenAI-compatible free tier: Groq (`https://api.groq.com/openai/v1`, `openai/gpt-oss-20b`), OpenRouter (`https://openrouter.ai/api/v1`, a `:free` model), GitHub Models (`https://models.github.ai/inference`, `openai/gpt-4.1-mini`). |
| `xai` | `XAI_API_KEY` with credits | Paid. Put it first in the chain once funded. |

`IMAGE_PROVIDER=pollinations` uses keyless `image.pollinations.ai` (model `flux`, which adds a small "pollinations.ai" watermark). `IMAGE_PROVIDER=xai` uses `grok-imagine-image-2.0`.

### Local Ollama on this box (how it was set up)
- The Ollama registry download is blocked by this box's network.
- So I imported the model from Hugging Face instead: `Qwen/Qwen2.5-1.5B-Instruct-GGUF`, file `qwen2.5-1.5b-instruct-q4_k_m.gguf`.
- Imported via a Modelfile (ChatML template, `num_ctx 4096`, `num_thread 4`): `ollama create archangel-qwen2.5-1.5b`.
- Server command: `OLLAMA_HOST=127.0.0.1:11434 OLLAMA_MODELS=~/ollama/models ~/ollama/bin/ollama serve`.

## Run locally
```bash
cp .env.example .env && chmod 600 .env   # set XAI_API_KEY and JWT_SECRET (openssl rand -hex 32)
npm install
npm run build && npm start               # listens on PORT (8811 here)
```
Data lives in `./data` (SQLite file and generated images). Override it with `DATA_DIR`.

## How the phone reaches it during development
- Quick tunnels with no account didn't work from this dev box. cloudflared's ports are blocked, and localtunnel returned Bad Gateway.
- Instead, `app/metro.config.js` proxies **`/api/*` on the Expo dev server to `localhost:8811`**.
- With `EXPO_PUBLIC_API_URL=auto`, the app calls `https://<current-expo-tunnel>.exp.direct/api`.
- So the backend is public only while `npx expo start --tunnel` is running. Its URL changes whenever the Expo tunnel URL changes, and the app follows automatically.
- If you use `cloudflared tunnel --url http://localhost:8811` on a normal network instead, note that **quick-tunnel URLs change on every restart**. You must update `EXPO_PUBLIC_API_URL` and restart Expo each time.

## Deploy to a real host (later)
These steps need an account with the host. Any Node host with a persistent disk works:

- **Render:** New → Web Service from this folder.
  - Build: `npm ci && npm run build`. Start: `npm start`.
  - Add a **Disk** mounted at `/data` and set `DATA_DIR=/data`.
  - Set the env vars from `.env.example`.
- **Railway:** New project from the repo with root `backend/`.
  - Same build and start commands.
  - Add a **Volume** at `/data` and set `DATA_DIR=/data`.
- **Fly.io:** run `fly launch` in `backend/`.
  - `fly volumes create data`, mounted at `/data`, with `DATA_DIR=/data`.
  - Store secrets with `fly secrets set XAI_API_KEY=... JWT_SECRET=...`.

Then:
1. Set `PUBLIC_URL=https://<your-service>` so image links use the public host.
2. In `app/.env`, set `EXPO_PUBLIC_API_URL=https://<your-service>` (no `/api` suffix) and restart Expo or rebuild.
3. Before a public launch:
   - Move SQLite to Postgres, or keep SQLite with backups.
   - Move images to object storage (S3/R2).
   - Add password reset and email verification.
   - Lock CORS down to your domains.

## Monetisation (test mode)
Plans (free/pro), credits, owned shop items and daily allowances live in `src/billing.ts`. Limits are enforced on the server: chat and image calls use the daily allowance first, then credits, and otherwise return HTTP 402 `limit_reached` with a `paywall` object.
- `GET /billing/products` (public catalogue, suggested AUD prices) · `GET /billing/status` · `GET /billing/history`
- `POST /billing/purchase {productId}`: **test mode only** (`BILLING_MODE=test`). It grants immediately and records `test=1`, with no charge.
- `POST /billing/restore` · `POST /billing/test/cancel`
- `POST /billing/webhooks/revenuecat`: for going live. Requires `Authorization: $REVENUECAT_WEBHOOK_AUTH`, uses `app_user_id` as our user id, and handles each transaction only once.
- `ADMIN_PRO_EMAILS`: comma-separated emails that always have Pro.
See `../launch/monetisation_plan.md` for the go-live steps.

## Database: local SQLite or Turso
`src/db.ts` uses `@libsql/client` for both:
- **Local (default):** `data/archangel.db` (same file as before) with images in `data/images/`.
- **Turso (hosted, free, no card):** set `TURSO_DATABASE_URL=libsql://<db>-<org>.turso.io` and `TURSO_AUTH_TOKEN`. Images are then stored as BLOBs in the database (`IMAGE_STORE=db`), so nothing depends on the host's disk.
- `/health` shows `db` (`sqlite-file` or `turso`) and `imageStore`.
- To copy the existing local data up: `npm run build && TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... node dist/migrate-to-turso.js`. It's safe to re-run.

## Deploy free: Render (API) + Turso (data and images)
Accounts needed (all free, no card): **GitHub**, **Turso** (sign in with GitHub), **Render** (sign in with GitHub). Optional: **UptimeRobot** (email or Google) to stop the API from sleeping.

1. **GitHub:** the backend lives in the private repo `topazarchangel-Michael/Archangel-Ai` (branch `main`), with this folder as the repo root. Never upload `.env`, `data/` or `node_modules/` (`.gitignore` already excludes them).
2. **Turso** (app.turso.tech):
   - Create a database `archangel` in the location nearest Sydney.
   - Copy its URL (`libsql://...`) and create a database token.
   - Optionally, from this box: `TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... node dist/migrate-to-turso.js` to bring the existing users, chats and images across.
3. **Render** (dashboard.render.com):
   - Choose New, then Blueprint, pick the repo, and Render reads `render.yaml` (free plan, Singapore region, Node 22).
   - Fill in the secret values when asked: `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `ADMIN_PRO_EMAILS`, and optionally `OPENAI_COMPAT_*` for Groq.
   - `JWT_SECRET` and `REVENUECAT_WEBHOOK_AUTH` are generated automatically.
   - Alternative: New, then Web Service, Docker (uses the `Dockerfile`).
4. Check `https://<service>.onrender.com/health`. It should show `"db":"turso"`.
5. **App:** set `EXPO_PUBLIC_API_URL=https://<service>.onrender.com` in `app/eas.json` (preview profile env) and rebuild the APK. That's one EAS build. Expo Go testing can keep using the box.
6. **Keep it awake (optional):** Render free services sleep after 15 minutes with no traffic, and the first request then takes about a minute.
   - A free UptimeRobot HTTP monitor on `/health` every 5–10 minutes keeps it awake.
   - One always-on service uses about 720–744 of the 750 free instance-hours a month.

Notes:
- The free Render instance has 0.1 CPU and 512 MB RAM. Ollama (local AI) can't run there, so use Pollinations or Groq.
- Logins (JWTs) made on the box won't work on Render, because it has a different `JWT_SECRET`. Users just log in again; their accounts migrate.
