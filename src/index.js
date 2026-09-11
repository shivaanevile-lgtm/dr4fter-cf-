import { Room } from './room-do.js';
export { Room };

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' }
});

function roomCodeGen() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Accept the Netlify-style paths too. It costs nothing and means an
    // index.html copied over from the old build still works instead of
    // failing with a confusing 404 from the static-asset layer.
    const isRoomApi    = url.pathname === '/api/room'     || url.pathname === '/.netlify/functions/room';
    const isPrefsApi   = url.pathname === '/api/ai-prefs' || url.pathname === '/.netlify/functions/ai-prefs';

    // ---- room API: forwarded to the Durable Object for that room code ----
    if (isRoomApi) {
      if (request.method !== 'POST') return json(405, { error: 'Method not allowed' });
      let body;
      try { body = await request.json(); }
      catch (e) { return json(400, { error: 'Bad JSON' }); }

      // Reading a saved result doesn't belong to any room — serve it from KV.
      if (body.action === 'result') {
        const id = String(body.resultId || '').toUpperCase();
        if (!id) return json(400, { error: 'Missing result id' });
        const snap = await env.RESULTS.get(id, { type: 'json' });
        if (!snap) return json(404, { error: `No saved result for ${id}. The link may be wrong, or the game never finished.` });
        return json(200, { result: snap });
      }

      // `create` invents the code; everything else must supply one.
      const code = body.action === 'create'
        ? roomCodeGen()
        : String(body.roomCode || '').toUpperCase();
      if (!code) return json(400, { error: 'Missing room code' });

      const id = env.ROOM.idFromName(code);
      const stub = env.ROOM.get(id);
      return stub.fetch('https://room/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, roomCode: code })
      });
    }

    // ---- shared AI-learning store (plain KV; races here are harmless) ----
    if (isPrefsApi) {
      if (request.method !== 'POST') return json(405, { error: 'Method not allowed' });
      let body;
      try { body = await request.json(); }
      catch (e) { return json(400, { error: 'Bad JSON' }); }
      const { action, itemKey } = body;
      if (!itemKey) return json(400, { error: 'Missing itemKey' });

      if (action === 'get') {
        const rec = await env.AIPREFS.get(itemKey, { type: 'json' });
        return json(200, { avg: rec ? Math.round(rec.sum / rec.count) : null, count: rec ? rec.count : 0 });
      }
      if (action === 'record') {
        const amount = parseInt(body.amount, 10);
        if (!(amount >= 0)) return json(400, { error: 'Invalid amount' });
        const rec = (await env.AIPREFS.get(itemKey, { type: 'json' })) || { sum: 0, count: 0 };
        rec.sum += amount; rec.count += 1;
        await env.AIPREFS.put(itemKey, JSON.stringify(rec));
        return json(200, { ok: true });
      }
      return json(400, { error: 'Unknown action' });
    }

    // ---- permanent result links: /r/ABC123 serves the app, which reads the path ----
    if (url.pathname.startsWith('/r/')) {
      return env.ASSETS.fetch(new Request(new URL('/index.html', request.url), request));
    }

    // ---- everything else is a static file ----
    return env.ASSETS.fetch(request);
  }
};
