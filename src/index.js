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

    // ---- image generation, run on Cloudflare's own models ----
    // Better prompt adherence than the public free endpoint we used before,
    // and it runs on this account rather than someone else's service.
    if (url.pathname === '/api/image') {
      if (request.method !== 'POST') return json(405, { error: 'Method not allowed' });
      if (!env.AI) return json(503, { error: 'Image generation is not configured on this deployment.' });
      let body;
      try { body = await request.json(); }
      catch (e) { return json(400, { error: 'Bad JSON' }); }
      const prompt = String(body.prompt || '').trim().slice(0, 1500);
      if (!prompt) return json(400, { error: 'Missing prompt' });
      const imageResponse = (bytes, mime) => new Response(bytes, {
        headers: { 'Content-Type': mime, 'Cache-Control': 'public, max-age=31536000, immutable' }
      });
      const b64ToBytes = (b64) => Uint8Array.from(atob(b64), c => c.charCodeAt(0));

      // Gemini first when a key is configured — it follows multi-object
      // prompts ("all five of these must appear") noticeably better than
      // flux-schnell. Falls straight back to Workers AI if the key is absent
      // or the call fails, so the button never simply breaks.
      if (env.GEMINI_API_KEY) {
        try {
          const gRes = await fetch(
            'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
              body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
            }
          );
          if (gRes.ok) {
            const data = await gRes.json();
            const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
            const img = parts.find(p => p.inlineData && p.inlineData.data);
            if (img) {
              return imageResponse(b64ToBytes(img.inlineData.data), img.inlineData.mimeType || 'image/png');
            }
          }
          // anything unexpected: fall through to Workers AI below
        } catch (e) { /* fall through */ }
      }

      try {
        const out = await env.AI.run('@cf/black-forest-labs/flux-1-schnell', {
          prompt,
          steps: 6                       // schnell is built for few steps; 6 is a good quality/latency point
        });
        return imageResponse(b64ToBytes(out.image), 'image/jpeg');
      } catch (e) {
        return json(502, { error: 'Could not generate an image right now: ' + (e.message || 'model error') });
      }
    }

    // ---- permanent result links: /r/ABC123 serves the app, which reads the path ----
    if (url.pathname.startsWith('/r/')) {
      return env.ASSETS.fetch(new Request(new URL('/index.html', request.url), request));
    }

    // ---- everything else is a static file ----
    return env.ASSETS.fetch(request);
  }
};
