# Dr4fter — Cloudflare Worker edition

This runs as a plain Cloudflare Worker: `src/index.js` is the entry point and
imports `room-do.js`, `engine.js` and `gamedata.js` as sibling modules.
`public/` is served as static assets via the `[assets]` binding in
wrangler.toml — `index.html` and everything else in that folder is served
directly, and any request the assets binding doesn't handle falls through to
the Worker.

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

## Deploy

```
npm install
npx wrangler kv namespace create RESULTS
npx wrangler kv namespace create AIPREFS
# paste the two ids into wrangler.toml if they differ from the ones already there
npx wrangler deploy
```

This deploys to your `*.workers.dev` subdomain (or a custom domain/route you
attach in the dashboard afterward). `wrangler.toml` already has the Durable
Object binding, both KV bindings, and the Workers AI binding wired up, so a
plain `wrangler deploy` picks all of it up with no dashboard configuration
needed.

### Deploying from GitHub instead

Cloudflare can also build and deploy a Worker automatically on every push:
dashboard → Workers & Pages → Create → import the repo. Since this is a plain
Worker (not Pages), it reads `wrangler.toml` directly, so no manual bindings
setup is required in the dashboard.

## Note on Durable Objects

DOs with SQLite storage are on Cloudflare's free tier, but verify current
limits before relying on it. If you'd rather avoid them entirely, the rooms
could be moved to KV — but KV has no compare-and-swap and is eventually
consistent, which would reintroduce exactly the races this design removes.
