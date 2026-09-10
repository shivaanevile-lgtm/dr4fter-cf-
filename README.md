# Dr4fter — Cloudflare edition

## What changed from the Netlify build

| Netlify | Cloudflare |
|---|---|
| `netlify/functions/room.js` | `src/room-do.js` (a Durable Object) |
| `netlify/functions/ai-prefs.js` | inlined in `src/index.js`, backed by KV |
| Netlify Blobs + ETag retries | Durable Object storage |
| `netlify.toml` | `wrangler.toml` |
| `/.netlify/functions/...` | `/api/...` |

`index.html` and `gamedata.js` are unchanged apart from the API paths and an
ESM export. All game logic moved across as `src/engine.js` untouched.

**The concurrency machinery is gone.** A Durable Object handles one request at
a time against strongly consistent storage, so the ETag optimistic-locking,
the retry loops and the stale-read workarounds aren't needed. That whole class
of bug is removed by construction rather than defended against.

## Deploy from GitHub

1. Push this folder to a GitHub repo.
2. Cloudflare dashboard → **Workers & Pages** → **Create** → **Workers** →
   **Connect to Git**, pick the repo.
3. Create two KV namespaces (Storage & Databases → KV):
   - one for `RESULTS`
   - one for `AIPREFS`
4. Paste their IDs into `wrangler.toml` where marked, commit, push.
5. Cloudflare builds and deploys on every push.

### Or from your machine
```
npm install
npx wrangler kv namespace create RESULTS
npx wrangler kv namespace create AIPREFS
# paste the two ids into wrangler.toml
npx wrangler deploy
```

## Note on Durable Objects

DOs with SQLite storage are on Cloudflare's free tier, but verify current
limits before relying on it. If you'd rather avoid them entirely, the rooms
could be moved to KV — but KV has no compare-and-swap and is eventually
consistent, which would reintroduce exactly the races this design removes.
