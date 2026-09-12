import {
  resultIdGen, buildResultSnapshot, autoFillRemaining, resolveThemeItems,
  buildCategoryQueue, draftedNames, newGame, playerNeedsCat, roomHost,
  sidesOf, sideLabel, mySideIndex, checkTeamConsensus, tickPendingTeamAction,
  applyResolvedAction, resolveItemToken, findHolder, drawNextLot, rerollLot,
  hostPickOptions, resolveLotWinner, roomExpired, expiryError, shuffle,
  CATEGORY_THEMES, ITEM_BY_ID, checkText
} from './engine.js';

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' }
});

/**
 * One Durable Object instance per room code.
 *
 * This is the big win over the Netlify build: a Durable Object processes its
 * requests ONE AT A TIME and its storage is strongly consistent. That removes
 * an entire class of bug by construction — no ETags, no optimistic-concurrency
 * retries, no stale reads, no "Not your turn" from a lagging replica. All of
 * that machinery is simply gone.
 */
export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async load() {
    return (await this.state.storage.get('room')) || null;
  }
  async save(room) {
    await this.state.storage.put('room', room);
  }

  // Snapshot a finished game to KV so the /r/<id> link outlives the room.
  async persistResultIfFinished(room) {
    if (!room || room.phase !== 'results' || !room.game || !room.game.resultId) return;
    if (room.game.resultSaved) return;
    try {
      await this.env.RESULTS.put(room.game.resultId, JSON.stringify(buildResultSnapshot(room)));
      room.game.resultSaved = true;
    } catch (e) { /* a failed snapshot must never break the game */ }
  }

  async fetch(request) {
    let body;
    try { body = await request.json(); }
    catch (e) { return json(400, { error: 'Bad JSON' }); }

    const { action } = body;
    let room = await this.load();

    try {
      if (action === 'create') {
        const themeResolved = resolveThemeItems(body.theme || {});
        const hostMode = body.hostMode === '3p' ? '3p' : body.hostMode === '2v2' ? '2v2' : '2p';
        room = {
          code: body.roomCode,
          hostMode,
          phase: 'lobby',
          theme: {
            key: (body.theme && body.theme.themeKey) || 'backyard',
            name: themeResolved.name, emoji: themeResolved.emoji,
            categoryTheme: themeResolved.categoryTheme,
            items: themeResolved.items || null,
            custom: (body.theme && body.theme.customTheme) || null
          },
          players: hostMode === '2v2'
            ? [{ nickname: body.nickname, role: 'creator', team: 0 }]
            : [{ nickname: body.nickname, role: hostMode === '3p' ? 'host' : 'creator', budget: 20, items: [] }],
          teams: hostMode === '2v2' ? [{ budget: 20, items: [] }, { budget: 20, items: [] }] : undefined,
          game: null,
          chat: [],
          createdAt: Date.now(),
          rev: 1
        };
        await this.save(room);
        return json(200, { room });
      }

      if (!room) {
        return json(404, {
          error: `No room with code ${String(body.roomCode || '').toUpperCase()}. Double-check the code, or create a new room.`,
          notFound: true
        });
      }
      if (roomExpired(room)) {
        const e = expiryError(room);
        return json(e.status, { error: e.error, expired: true });
      }

      // A stale 2v2 proposal resolves itself before anything else is considered.
      if (room.hostMode === '2v2' && tickPendingTeamAction(room)) await this.save(room);

      if (action === 'state') {
        if (body.nickname && (room.kicked || []).includes(body.nickname)
            && !room.players.some(p => p.nickname === body.nickname)) {
          return json(403, { error: 'The host removed you from this room.', kicked: true });
        }
        await this.persistResultIfFinished(room);
        if (room.game && room.game.resultSaved) await this.save(room);
        const opts = (room.game && room.game.awaitingHostPick) ? hostPickOptions(room) : null;
        return json(200, { room, options: opts });
      }

      if (action === 'join') {
        const needed = room.hostMode === '3p' ? 3 : room.hostMode === '2v2' ? 4 : 2;
        if (room.players.some(p => p.nickname === body.nickname)) {
          // Rejoining with the same nickname: their earlier attempt landed but
          // the response never reached them. Welcome them back rather than erroring.
          return json(200, { room });
        }
        if (room.players.length >= needed) {
          return json(400, { error: `Room is full (${room.players.length}/${needed}). Players already in: ${room.players.map(p => `${p.nickname}[${p.role}]`).join(', ')}.` });
        }
        if (room.hostMode === '2v2') {
          const counts = [0, 0];
          room.players.forEach(p => counts[p.team]++);
          room.players.push({ nickname: body.nickname, role: 'bidder', team: counts[0] < 2 ? 0 : 1 });
        } else {
          room.players.push({ nickname: body.nickname, role: 'bidder', budget: 20, items: [] });
        }
        // The game no longer starts itself — the host presses Start. That's what
        // makes kicking useful: a full room can still be reshuffled first.
        room.chat = room.chat || [];
        room.chat.push({ sys: true, text: `${body.nickname} joined`, at: Date.now() });
        await this.save(room);
        return json(200, { room });
      }

      if (action === 'start') {
        const requester = room.players.find(p => p.nickname === body.nickname);
        if (!requester || (requester.role !== 'host' && requester.role !== 'creator')) {
          return json(403, { error: 'Only the host can start the game' });
        }
        if (room.phase !== 'lobby') return json(400, { error: 'The game has already started' });
        const needed = room.hostMode === '3p' ? 3 : room.hostMode === '2v2' ? 4 : 2;
        if (room.players.length < needed) {
          return json(400, { error: `Need ${needed} players to start — ${room.players.length} so far.` });
        }
        room.phase = 'drafting';
        if (room.hostMode === '2v2') room.teams = [{ budget: 20, items: [] }, { budget: 20, items: [] }];
        room.game = newGame(resolveThemeItems({ themeKey: room.theme.key, customTheme: room.theme.custom }));
        room.game.resultId = resultIdGen();
        drawNextLot(room);
        room.chat = room.chat || [];
        room.chat.push({ sys: true, text: 'The draft has started', at: Date.now() });
        await this.save(room);
        // hosted rooms need the pick list straight away, or the host stares at
        // "Loading options…" until the next poll
        return json(200, { room, options: room.game.awaitingHostPick ? hostPickOptions(room) : null });
      }

      if (action === 'leave') {
        const idx = room.players.findIndex(p => p.nickname === body.nickname);
        if (idx < 0) return json(200, { room, left: true });   // already gone
        // Mid-draft we keep the seat: the game is built around a fixed number
        // of sides, and they can rejoin with the same nickname. Only a lobby
        // departure actually frees the seat.
        if (room.phase !== 'lobby') {
          room.chat = room.chat || [];
          room.chat.push({ sys: true, text: `${body.nickname} disconnected`, at: Date.now() });
          await this.save(room);
          return json(200, { room, left: true });
        }
        const was = room.players[idx];
        room.players.splice(idx, 1);
        // hand the room over rather than leaving it hostless
        if ((was.role === 'creator' || was.role === 'host') && room.players.length) {
          room.players[0].role = was.role;
        }
        if (room.hostMode === '2v2') {
          const counts = [0, 0];
          room.players.forEach(p => { p.team = counts[0] <= counts[1] ? 0 : 1; counts[p.team]++; });
        }
        room.chat = room.chat || [];
        room.chat.push({ sys: true, text: `${body.nickname} left`, at: Date.now() });
        await this.save(room);
        return json(200, { room, left: true });
      }

      if (action === 'kick') {
        const requester = room.players.find(p => p.nickname === body.nickname);
        if (!requester || (requester.role !== 'host' && requester.role !== 'creator')) {
          return json(403, { error: 'Only the host can remove players' });
        }
        if (room.phase !== 'lobby') return json(400, { error: 'You can only remove players before the draft starts' });
        const target = String(body.target || '');
        if (target === body.nickname) return json(400, { error: "You can't remove yourself — leave the room instead." });
        const idx = room.players.findIndex(p => p.nickname === target);
        if (idx < 0) return json(400, { error: `${target} isn't in this room.` });
        room.players.splice(idx, 1);
        // 2v2 seats must stay balanced after a removal
        if (room.hostMode === '2v2') {
          const counts = [0, 0];
          room.players.forEach(p => { p.team = counts[0] <= counts[1] ? 0 : 1; counts[p.team]++; });
        }
        room.kicked = room.kicked || [];
        room.kicked.push(target);
        room.chat = room.chat || [];
        room.chat.push({ sys: true, text: `${target} was removed by the host`, at: Date.now() });
        await this.save(room);
        return json(200, { room });
      }

      if (action === 'chat') {
        const me = room.players.find(p => p.nickname === body.nickname);
        if (!me) return json(403, { error: 'Not in this room' });
        const bad = checkText(body.text, 'Message', 140);
        if (bad) return json(400, { error: bad });
        room.chat = room.chat || [];
        room.chat.push({ nick: body.nickname, text: String(body.text).trim().slice(0, 140), at: Date.now() });
        // keep the log short; nobody scrolls back further than this
        if (room.chat.length > 60) room.chat = room.chat.slice(-60);
        await this.save(room);
        return json(200, { room });
      }

      if (action === 'raise' || action === 'pass' || action === 'skip' || action === 'claim') {
        if (room.phase !== 'drafting' || !room.game || !room.game.currentLot) return json(400, { error: 'No active lot' });
        if (room.game.awaitingHostPick) return json(400, { error: 'Waiting for the host to choose the lot' });
        const g = room.game;
        const bidders = sidesOf(room);
        const myIdx = mySideIndex(room, body.nickname);
        if (myIdx < 0) return json(403, { error: 'Not a bidder in this room' });

        if (action === 'raise') {
          if (g.mode !== 'contested' || g.turnIdx !== myIdx) return json(400, { error: 'Not your turn' });
          const amount = parseInt(body.amount, 10);
          if (!(amount > g.currentBid) || amount > bidders[myIdx].budget) return json(400, { error: 'Invalid raise' });
          if (checkTeamConsensus(room, myIdx, body.nickname, 'raise', amount)) applyResolvedAction(room, myIdx, 'raise', amount);
        } else if (action === 'pass') {
          if (g.mode !== 'contested' || g.turnIdx !== myIdx) return json(400, { error: 'Not your turn' });
          if (checkTeamConsensus(room, myIdx, body.nickname, 'pass', null)) applyResolvedAction(room, myIdx, 'pass', null);
        } else if (action === 'skip') {
          if (roomHost(room)) return json(400, { error: 'The host chooses the lots in this room' });
          if (g.mode !== 'solo' || g.soloPlayerIdx !== myIdx) return json(400, { error: 'Not your turn' });
          if (checkTeamConsensus(room, myIdx, body.nickname, 'skip', null)) applyResolvedAction(room, myIdx, 'skip', null);
        } else if (action === 'claim') {
          if (g.mode !== 'solo' || g.soloPlayerIdx !== myIdx) return json(400, { error: 'Not your turn' });
          const budget = bidders[myIdx].budget;
          const amount = budget === 0 ? 0 : Math.max(1, Math.min(budget, parseInt(body.amount, 10) || 1));
          if (checkTeamConsensus(room, myIdx, body.nickname, 'claim', amount)) applyResolvedAction(room, myIdx, 'claim', amount);
        }

        await this.persistResultIfFinished(room);
        await this.save(room);
        return json(200, { room });
      }

      if (action === 'hostPick') {
        const host = roomHost(room);
        if (!host) return json(400, { error: 'This room has no host' });
        if (host.nickname !== body.nickname) return json(403, { error: 'Only the host picks lots' });
        const g = room.game;
        if (!g) return json(400, { error: 'No active game' });
        if (!g.awaitingHostPick) return json(400, { error: 'A lot is already up' });

        const options = hostPickOptions(room);
        const arg = String(body.item || '').trim();
        let chosen = null;

        if (body.custom) {
          const bad = checkText(arg, 'Item name');
          if (bad) return json(400, { error: bad });
          if (draftedNames(room).has(arg)) return json(400, { error: `"${arg}" has already been drafted` });
          let rating = parseInt(body.rating, 10);
          if (isNaN(rating)) rating = 6;
          rating = Math.max(1, Math.min(10, rating));
          const cat = g.catThemeKey ? (g.pickCat || CATEGORY_THEMES[g.catThemeKey].cats[g.catIdx]) : null;
          chosen = { name: arg, r: rating, cat, custom: true };
        } else {
          if (!options.length) { room.phase = 'results'; g.currentLot = null; g.awaitingHostPick = false; }
          if (/^\d+$/.test(arg)) {
            const rec = ITEM_BY_ID[parseInt(arg, 10)];
            if (rec) chosen = options.find(o => o.name === rec.name);
          }
          if (!chosen && arg) {
            const lower = arg.toLowerCase();
            chosen = options.find(o => o.name.toLowerCase() === lower)
                  || options.find(o => o.name.toLowerCase().includes(lower));
          }
          if (!chosen) return json(400, { error: `"${body.item}" isn't available in this category` });
        }

        const strip = arr => { if (!arr) return; const i = arr.findIndex(x => (x[0] || x.name) === chosen.name); if (i > -1) arr.splice(i, 1); };
        strip(g.catQueue); strip(g.itemPool);

        const bidders = sidesOf(room);
        let wanting;
        if (g.catThemeKey) {
          const ct = CATEGORY_THEMES[g.catThemeKey];
          wanting = bidders.map((p, i) => i).filter(i => playerNeedsCat(bidders[i], chosen.cat, ct.required));
        } else {
          wanting = bidders.map((p, i) => i).filter(i => (bidders[i].items || []).length < 5);
        }
        if (!wanting.length) { room.phase = 'results'; g.currentLot = null; g.awaitingHostPick = false; }
        else {
          g.awaitingHostPick = false;
          g.pickCat = null;
          g.currentLot = { name: chosen.name, r: chosen.r, cat: chosen.cat };
          const { startLotMode } = await import('./engine.js');
          startLotMode(g, wanting);
        }

        await this.persistResultIfFinished(room);
        await this.save(room);
        return json(200, { room, options: hostPickOptions(room) });
      }

      if (action === 'newRound') {
        const requester = room.players.find(p => p.nickname === body.nickname);
        if (!requester || (requester.role !== 'host' && requester.role !== 'creator')) {
          return json(403, { error: 'Only the host can start a rematch' });
        }
        const themeResolved = resolveThemeItems(body.theme || {});
        room.theme = {
          key: (body.theme && body.theme.themeKey) || room.theme.key,
          name: themeResolved.name, emoji: themeResolved.emoji,
          categoryTheme: themeResolved.categoryTheme,
          items: themeResolved.items || null,
          custom: (body.theme && body.theme.customTheme) || null
        };
        if (room.hostMode === '2v2') room.teams = [{ budget: 20, items: [] }, { budget: 20, items: [] }];
        else room.players.forEach(p => { if (p.role !== 'host') { p.budget = 20; p.items = []; } });
        room.game = newGame(themeResolved);
        room.game.resultId = resultIdGen();
        room.phase = 'drafting';
        drawNextLot(room);
        await this.save(room);
        return json(200, { room });
      }

      if (action === 'debug') {
        const g = room.game;
        if (!g) return json(400, { error: 'No active game' });
        const bidders = sidesOf(room);
        const myIdx = mySideIndex(room, body.nickname);
        if (myIdx < 0) return json(403, { error: 'Not a bidder in this room' });
        const cmd = (body.cmd || '').toLowerCase();
        const arg = body.arg || '';
        let notice = null;

        if (cmd === 'money' || cmd === 'money+') {
          const parts = String(arg).trim().split(/\s+/);
          const amt = parseInt(parts[0], 10);
          if (isNaN(amt)) return json(400, { error: 'Usage: money <amount> [nickname]' });
          const targetName = parts.slice(1).join(' ').trim();
          let target = bidders[myIdx];
          if (targetName) {
            const p = room.players.find(pl => pl.nickname.toLowerCase() === targetName.toLowerCase());
            const ti = p ? mySideIndex(room, p.nickname) : -1;
            target = ti >= 0 ? bidders[ti] : null;
            if (!target) return json(400, { error: `No bidder named "${targetName}". In this room: ${room.players.map(p => p.nickname).join(', ')}` });
          }
          target.budget = cmd === 'money' ? amt : target.budget + amt;
          if (target.budget < 0) target.budget = 0;

        } else if (cmd === 'finish' || cmd === 'end') {
          if (room.phase === 'results') return json(400, { error: 'This game has already finished.' });
          const filled = autoFillRemaining(room);
          notice = filled
            ? `Skipped to the end — auto-filled ${filled} remaining slot${filled === 1 ? '' : 's'} for free.`
            : 'Skipped to the end — every slot was already filled.';

        } else if (cmd === 'rig') {
          if (room.phase !== 'drafting' || !g.currentLot) return json(400, { error: 'No active lot to rig.' });
          let target = null;
          if (arg) {
            const res = resolveItemToken(room, arg);
            if (res.error) return json(400, { error: res.error });
            if (findHolder(room, res.rec.name)) return json(400, { error: `"${res.rec.name}" is already drafted.` });
            target = res.rec;
            // queue it so it comes up next, then rig that one
            g.pendingNext = g.pendingNext || {};
            const key = target.cat || '_';
            g.pendingNext[key] = g.pendingNext[key] || [];
            if (!g.pendingNext[key].some(it => (it[0] || it.name) === target.name)) {
              g.pendingNext[key].push(g.catThemeKey ? [target.name, target.r] : { name: target.name, r: target.r });
              const strip = arr => { if(!arr) return; const i = arr.findIndex(x => (x[0]||x.name) === target.name); if(i>-1) arr.splice(i,1); };
              strip(g.catQueue); strip(g.itemPool);
            }
          }
          g.rigged = { side: myIdx, name: target ? target.name : g.currentLot.name };
          notice = target
            ? `Rigged: #${target.id} ${target.name} comes up next and is yours whatever happens.`
            : `Rigged: "${g.currentLot.name}" is yours whatever happens.`;

        } else if (cmd === 'skip') {
          if (room.phase !== 'drafting') return json(400, { error: 'The draft has finished.' });
          const sides = sidesOf(room);
          if (sides.length < 2) return json(400, { error: 'Nobody to skip.' });
          let targetIdx = 1 - myIdx;
          if (arg) {
            const p = room.players.find(pl => pl.nickname.toLowerCase() === String(arg).trim().toLowerCase());
            targetIdx = p ? mySideIndex(room, p.nickname) : -1;
            if (targetIdx < 0) return json(400, { error: `No bidder named "${arg}". In this room: ${room.players.map(p=>p.nickname).join(', ')}` });
          }
          g.forcedPass = targetIdx;
          notice = `${sideLabel(room, targetIdx)} must pass their next turn.`;

        } else if (cmd === 'reroll') {
          if (room.phase !== 'drafting' || !g.currentLot) return json(400, { error: 'No active lot to reroll.' });
          if (g.awaitingHostPick) return json(400, { error: 'The host is choosing the lot — nothing to reroll.' });
          const was = g.currentLot.name;
          const now = rerollLot(room);
          if (!now) return json(400, { error: `Nothing left to swap "${was}" for.` });
          g.currentBid = 0; g.currentBidderIdx = null; g.passStreak = 0;
          g.tickerLog = [];
          notice = g.catThemeKey
            ? `Rerolled ${g.currentLot.cat}: "${was}" → "${now.name}" (${now.r}/10)`
            : `Rerolled: "${was}" → "${now.name}" (${now.r}/10)`;

        } else if (cmd === 'swapall') {
          const a = bidders[0], b = bidders[1];
          if (!a || !b) return json(400, { error: 'Need two sides to swap rosters' });
          const tmp = a.items; a.items = b.items; b.items = tmp;
          notice = `Swapped entire rosters — ${sideLabel(room, 0)} (${a.items.length}) ⇄ ${sideLabel(room, 1)} (${b.items.length})`;

        } else if (cmd === 'give') {
          const parts = String(arg).trim().split(/\s+/).filter(Boolean);
          if (!parts.length) return json(400, { error: 'Usage: give <id> [nickname]' });
          const res = resolveItemToken(room, parts[0]);
          if (res.error) return json(400, { error: res.error });
          const rec = res.rec;
          let targetIdx = myIdx;
          const targetName = parts.slice(1).join(' ').trim();
          if (targetName) {
            const p = room.players.find(pl => pl.nickname.toLowerCase() === targetName.toLowerCase());
            targetIdx = p ? mySideIndex(room, p.nickname) : -1;
            if (targetIdx < 0) return json(400, { error: `No bidder named "${targetName}". In this room: ${room.players.map(p => p.nickname).join(', ')}` });
          }
          const holder = findHolder(room, rec.name);
          if (holder && holder.sideIdx === targetIdx) return json(400, { error: `${sideLabel(room, targetIdx)} already has "${rec.name}".` });
          const item = holder ? holder.item : { name: rec.name, r: rec.r, cat: rec.cat, paid: 0 };
          if (g.catThemeKey && item.cat) {
            const ct = CATEGORY_THEMES[g.catThemeKey];
            const have = (bidders[targetIdx].items || []).filter(it => it.cat === item.cat).length;
            if (have >= ct.required[item.cat]) return json(400, { error: `${sideLabel(room, targetIdx)}'s ${item.cat} slot${ct.required[item.cat] > 1 ? 's are' : ' is'} already full (${have}/${ct.required[item.cat]}).` });
          } else if (!g.catThemeKey && (bidders[targetIdx].items || []).length >= 5) {
            return json(400, { error: `${sideLabel(room, targetIdx)} already has 5 items.` });
          }
          if (holder) bidders[holder.sideIdx].items.splice(holder.itemIdx, 1);
          else {
            const strip = arr => { if (!arr) return; const i = arr.findIndex(x => (x[0] || x.name) === rec.name); if (i > -1) arr.splice(i, 1); };
            strip(g.catQueue); strip(g.itemPool);
            if (g.pendingNext) Object.keys(g.pendingNext).forEach(k => strip(g.pendingNext[k]));
          }
          bidders[targetIdx].items.push(item);
          notice = holder
            ? `Moved #${rec.id} ${rec.name} from ${sideLabel(room, holder.sideIdx)} to ${sideLabel(room, targetIdx)}`
            : `Gave #${rec.id} ${rec.name} to ${sideLabel(room, targetIdx)} straight from the pool`;

        } else if (cmd === 'steal') {
          if (!arg) return json(400, { error: 'Usage: steal <id or item name>' });
          const res = resolveItemToken(room, arg);
          if (res.error) return json(400, { error: res.error });
          const rec = res.rec;
          const holder = findHolder(room, rec.name);
          if (!holder) return json(400, { error: `Nobody has drafted "${rec.name}" yet — there's nothing to steal. Use "next ${rec.id}" to put it up for auction instead.` });
          if (holder.sideIdx === myIdx) return json(400, { error: `You already have "${rec.name}" — you can't steal from yourself.` });
          const stolen = holder.item;
          if (g.catThemeKey && stolen.cat) {
            const ct = CATEGORY_THEMES[g.catThemeKey];
            const have = (bidders[myIdx].items || []).filter(it => it.cat === stolen.cat).length;
            if (have >= ct.required[stolen.cat]) return json(400, { error: `Your ${stolen.cat} slot${ct.required[stolen.cat] > 1 ? 's are' : ' is'} already full (${have}/${ct.required[stolen.cat]}).` });
          } else if (!g.catThemeKey && (bidders[myIdx].items || []).length >= 5) {
            return json(400, { error: `You already have 5 items.` });
          }
          bidders[holder.sideIdx].items.splice(holder.itemIdx, 1);
          bidders[myIdx].items.push(stolen);
          notice = `Stole #${rec.id} ${rec.name} from ${sideLabel(room, holder.sideIdx)}`;

        } else if (cmd === 'swap') {
          const parts = String(arg).trim().split(/\s+/).filter(Boolean);
          if (parts.length < 2) return json(400, { error: 'Usage: swap <id1> <id2>' });
          const a = resolveItemToken(room, parts[0]);
          if (a.error) return json(400, { error: a.error });
          const b = resolveItemToken(room, parts.slice(1).join(' '));
          if (b.error) return json(400, { error: b.error });
          if (a.rec.name === b.rec.name) return json(400, { error: `Those are the same item ("${a.rec.name}")` });
          const ha = findHolder(room, a.rec.name), hb = findHolder(room, b.rec.name);
          if (!ha) return json(400, { error: `Nobody has drafted "${a.rec.name}" yet — there's nothing to swap.` });
          if (!hb) return json(400, { error: `Nobody has drafted "${b.rec.name}" yet — there's nothing to swap.` });
          if (ha.sideIdx === hb.sideIdx) return json(400, { error: `Both belong to ${sideLabel(room, ha.sideIdx)} — a swap has to be between two different sides.` });
          if (g.catThemeKey && ha.item.cat !== hb.item.cat) return json(400, { error: `Can't swap a ${ha.item.cat} for a ${hb.item.cat} — swap within the same category.` });
          bidders[ha.sideIdx].items[ha.itemIdx] = hb.item;
          bidders[hb.sideIdx].items[hb.itemIdx] = ha.item;
          notice = `Swapped ${a.rec.name} (${sideLabel(room, ha.sideIdx)}) for ${b.rec.name} (${sideLabel(room, hb.sideIdx)})`;

        } else if (cmd === 'next') {
          if (!arg) return json(400, { error: 'Usage: next <id or item name>' });
          const res = resolveItemToken(room, arg);
          if (res.error) return json(400, { error: res.error });
          const rec = res.rec;
          if (draftedNames(room).has(rec.name)) return json(400, { error: `"${rec.name}" is already drafted` });
          if (g.currentLot && g.currentLot.name === rec.name) return json(400, { error: `"${rec.name}" is already the current lot` });
          g.pendingNext = g.pendingNext || {};
          const key = rec.cat || '_';
          g.pendingNext[key] = g.pendingNext[key] || [];
          if (!g.pendingNext[key].some(it => (it[0] || it.name) === rec.name)) {
            g.pendingNext[key].push(g.catThemeKey ? [rec.name, rec.r] : { name: rec.name, r: rec.r });
            const strip = arr => { if (!arr) return; const i = arr.findIndex(x => (x[0] || x.name) === rec.name); if (i > -1) arr.splice(i, 1); };
            strip(g.catQueue); strip(g.itemPool);
          }
          notice = `#${rec.id} ${rec.name}${rec.cat ? ' (' + rec.cat + ')' : ''} queued up next`;

        } else {
          return json(400, { error: `Unknown command: ${cmd}` });
        }

        await this.persistResultIfFinished(room);
        await this.save(room);
        return json(200, { room, notice });
      }

      return json(400, { error: 'Unknown action' });

    } catch (err) {
      return json(500, { error: err.message || 'Server error' });
    }
  }
}
