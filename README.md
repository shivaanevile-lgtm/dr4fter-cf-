# Dr4fter — Cloudflare Pages edition

This runs as a Cloudflare Pages project in "advanced mode": `public/` is the
static asset folder Pages serves directly (index.html, images, etc.), and
`public/_worker.js/` is a directory-based Worker that Pages runs for every
request — its `index.js` is the entry point, and it imports `room-do.js`,
`engine.js` and `gamedata.js` as plain sibling modules, same as a standalone
Worker would. Pages hands that Worker an `ASSETS` binding automatically to
fall back to the static files sitting next to it, so nothing in the code
itself changed — only where the files live and how it's deployed.

(An earlier version of this ran as a plain Cloudflare Worker instead of
Pages — same code, just under `src/` with a `main =` entry in wrangler.toml
and an explicit `[assets]` block. Converted to Pages for the shorter/cleaner
project URL and git-based auto-deploy.)

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
2. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** →
   **Connect to Git**, pick the repo.
3. Build settings: no build command needed (this is a static folder plus a
   Worker, nothing to compile) — set the build output directory to `public`.
4. Create two KV namespaces (Storage & Databases → KV):
   - one for `RESULTS`
   - one for `AIPREFS`
5. Paste their IDs into `wrangler.toml` where marked (replacing the
   `REPLACE_WITH_NEW_..._NAMESPACE_ID` placeholders), commit, push.
6. In the Pages project's Settings → Functions → Bindings, add the same KV
   namespaces, the `ROOM` Durable Object binding, and the `AI` binding —
   wrangler.toml drives a CLI deploy, but a git-connected Pages project also
   needs these set in the dashboard so the auto-deploy build picks them up.
7. Cloudflare builds and deploys on every push, at the project's own
   `<project-name>.pages.dev` URL (or a custom domain attached to it).

### Or from your machine
```
npm install
npx wrangler kv namespace create RESULTS
npx wrangler kv namespace create AIPREFS
# paste the two ids into wrangler.toml
npx wrangler pages deploy public
```
The first deploy from the CLI will ask you to create or pick the Pages
project it belongs to.

## Note on Durable Objects

DOs with SQLite storage are on Cloudflare's free tier, but verify current
limits before relying on it. If you'd rather avoid them entirely, the rooms
could be moved to KV — but KV has no compare-and-swap and is eventually
consistent, which would reintroduce exactly the races this design removes.
