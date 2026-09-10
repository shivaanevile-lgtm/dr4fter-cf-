// Pure game engine — no storage, no platform APIs. Shared by the Durable
// Object. Ported unchanged from the Netlify build so the game logic (and all
// the edge cases already fixed) carries over exactly.
import { THEMES, CATEGORY_THEMES, ITEM_BY_ID, checkText } from './gamedata.js';

function resultIdGen(){
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i=0;i<6;i++) s += chars[Math.floor(Math.random()*chars.length)];
  return s;
}
// Snapshot a finished game so it survives the room's 12-hour lifetime.
function buildResultSnapshot(room){
  const sides = sidesOf(room);
  return {
    id: room.game.resultId,
    theme: { key: room.theme.key, name: room.theme.name, emoji: room.theme.emoji },
    hostMode: room.hostMode,
    sides: sides.map((s, i) => ({
      label: room.hostMode === '2v2'
        ? (i === 0 ? 'Team A' : 'Team B') + ' (' + room.players.filter(p=>p.team===i).map(p=>p.nickname).join(' & ') + ')'
        : s.nickname,
      budget: s.budget,
      items: (s.items||[]).map(it => ({ name: it.name, r: it.r, cat: it.cat, paid: it.paid }))
    })),
    bidLog: room.game.bidLog || [],
    finishedAt: Date.now()
  };
}

// Called after any action; saves the snapshot the first time a room lands on
// results, so every path that ends a game is covered without hooking each one.

// Fill every empty slot from what's left in the pool (free), then end the
// game. Used by the `finish` console command.
function autoFillRemaining(room){
  const g = room.game;
  const sides = sidesOf(room);
  const drafted = draftedNames(room);
  let filled = 0;

  if (g.catThemeKey) {
    const ct = CATEGORY_THEMES[g.catThemeKey];
    ct.cats.forEach(cat => {
      const available = shuffle(
        (ct.pool[cat]||[]).concat(ct.icons ? (ct.icons[cat]||[]) : [])
          .filter(p => !drafted.has(p[0]))
      );
      sides.forEach(side => {
        while (playerNeedsCat(side, cat, ct.required)) {
          const pick = available.shift();
          if (!pick) break;
          drafted.add(pick[0]);
          side.items.push({ name: pick[0], r: pick[1], cat, paid: 0 });
          filled++;
        }
      });
    });
  } else {
    const available = shuffle((g.itemPool||[]).filter(it => !drafted.has(it.name)));
    sides.forEach(side => {
      while ((side.items||[]).length < 5) {
        const pick = available.shift();
        if (!pick) break;
        drafted.add(pick.name);
        side.items.push({ name: pick.name, r: pick.r, cat: null, paid: 0 });
        filled++;
      }
    });
  }

  g.currentLot = null;
  g.awaitingHostPick = false;
  g.mode = 'idle';
  g.pendingAction = null;
  room.phase = 'results';
  return filled;
}


function roomCodeGen(){
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i=0;i<5;i++) s += chars[Math.floor(Math.random()*chars.length)];
  return s;
}
function shuffle(arr){
  const a = arr.slice();
  for (let i=a.length-1;i>0;i--){ const j = Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; }
  return a;
}

function resolveThemeItems(theme){
  if (CATEGORY_THEMES[theme.themeKey]) {
    const ct = CATEGORY_THEMES[theme.themeKey];
    return { categoryTheme: theme.themeKey, name: ct.name, emoji: ct.emoji };
  }
  if (theme.themeKey === 'custom' && theme.customTheme) {
    return { categoryTheme: null, name: theme.customTheme.name, emoji:'✏️', items: theme.customTheme.items };
  }
  const t = THEMES[theme.themeKey];
  if (!t) throw new Error('Unknown theme');
  return { categoryTheme: null, name:t.name, emoji:t.emoji, items:t.items };
}

function buildCategoryQueue(catThemeKey, cat, exclude){
  const ct = CATEGORY_THEMES[catThemeKey];
  const skip = exclude || new Set();
  const keep = arr => arr.filter(it => !skip.has(it[0]));
  const poolShuffled = shuffle(keep(ct.pool[cat]));
  if (!ct.icons) return poolShuffled;
  const iconsAll = shuffle(keep(ct.icons[cat]));
  const icons3 = iconsAll.slice(0,3);
  const restIcons = icons3.slice(1);
  const rest = shuffle(restIcons.concat(poolShuffled));
  return icons3.length ? [icons3[0]].concat(rest) : rest;
}
// Names already on someone's team — a refilled queue must never re-offer them.
function draftedNames(room){
  const out = new Set();
  sidesOf(room).forEach(p => (p.items||[]).forEach(it => out.add(it.name)));
  return out;
}

function newGame(themeResolved){
  const g = {
    gameId: Date.now().toString(36) + Math.random().toString(36).slice(2,7),
    resultId: resultIdGen(),
    catThemeKey: themeResolved.categoryTheme || null,
    turnIdx: 0,
    openerIdx: 0,
    mode: 'idle',
    currentLot: null,
    currentBid: 0,
    currentBidderIdx: null,
    soloPlayerIdx: null,
    skipsUsed: 0,
    passStreak: 0,
    tickerLog: [],
    bidLog: [],
    catIdx: 0,
    catQueue: null,
    itemPool: null
  };
  if (g.catThemeKey) {
    const ct = CATEGORY_THEMES[g.catThemeKey];
    g.catQueue = buildCategoryQueue(g.catThemeKey, ct.cats[0]);
  } else {
    g.itemPool = shuffle(themeResolved.items.map(it => ({ name: it[0], r: it[1] })));
  }
  return g;
}

function playerNeedsFlat(p){ return p.items.length < 5; }
function playerNeedsCat(p, cat, requiredMap){ return p.items.filter(it => it.cat === cat).length < requiredMap[cat]; }

function roomHost(room){ return room.players.find(p => p.role === 'host'); }
// The "contestants" in the auction — one entry per player normally, or one
// entry per TEAM in a 2v2 room (so budget/items are shared, not per-person).
function sidesOf(room){
  return room.hostMode === '2v2' ? room.teams : room.players.filter(p => p.role !== 'host');
}
function sideLabel(room, sideIdx){
  if (room.hostMode === '2v2') return sideIdx === 0 ? 'Team A' : 'Team B';
  const s = sidesOf(room)[sideIdx];
  return s ? s.nickname : '?';
}

// In a 2v2 room, both teammates must submit the SAME proposal before it takes
// effect. Returns true if the action should execute now (consensus reached,
// or this isn't a team room at all); false if it was only recorded and is
// waiting on the teammate — the caller should stop without executing.
function checkTeamConsensus(room, sideIdx, nickname, type, amount){
  if (room.hostMode !== '2v2') return true;
  const g = room.game;
  const amt = amount === undefined ? null : amount;
  const pa = g.pendingAction;
  const matches = pa && pa.team === sideIdx && pa.type === type && pa.amount === amt;
  if (matches) {
    if (!pa.agreedBy.includes(nickname)) pa.agreedBy.push(nickname);
    if (pa.agreedBy.length >= 2) { g.pendingAction = null; return true; }
    return false;
  }
  g.pendingAction = { team: sideIdx, type, amount: amt, agreedBy: [nickname], expiresAt: Date.now() + 20000 };
  return false;
}

// If a team's teammate never responded, don't stall the game — treat the
// silence as tacit agreement once the 20s window is up. Called at the top of
// every request that touches this room, so it fires on the next poll/action
// regardless of who happens to make it.
function tickPendingTeamAction(room){
  const g = room.game;
  if (!g || !g.pendingAction) return false;
  if (Date.now() < g.pendingAction.expiresAt) return false;
  const pa = g.pendingAction;
  g.pendingAction = null;
  applyResolvedAction(room, pa.team, pa.type, pa.amount);
  return true;
}

// The actual state mutation for a resolved (consensus-reached, or
// non-team-room) raise/pass/skip/claim. Shared by the normal path and the
// timeout path so they can never drift out of sync with each other.
function applyResolvedAction(room, sideIdx, type, amount){
  const g = room.game;
  const bidders = sidesOf(room);
  if (type === 'raise') {
    g.currentBid = amount; g.currentBidderIdx = sideIdx; g.passStreak = 0;
    g.tickerLog.push(`${sideLabel(room, sideIdx)}: $${amount}`);
    g.turnIdx = 1 - sideIdx;
  } else if (type === 'pass') {
    g.tickerLog.push(`${sideLabel(room, sideIdx)}: pass`);
    if (g.currentBidderIdx === null) {
      g.passStreak = (g.passStreak||0) + 1;
      if (g.passStreak >= 2) {
        const allBroke = bidders.every(p => p.budget < 1);
        if (allBroke) resolveLotWinner(room, sideIdx, 0);
        else unsoldLot(room);
      } else { g.turnIdx = 1 - sideIdx; }
    } else {
      resolveLotWinner(room, g.currentBidderIdx, g.currentBid);
    }
  } else if (type === 'claim') {
    resolveLotWinner(room, sideIdx, amount);
  } else if (type === 'skip') {
    g.skipsUsed++;
    if (g.skipsUsed >= 4) {
      resolveLotWinner(room, sideIdx, bidders[sideIdx].budget === 0 ? 0 : 1);
    } else {
      const cat = g.currentLot.cat;
      const passedOver = g.currentLot;
      if (g.catThemeKey) {
        const cand = g.catQueue.shift();
        if (cand) { g.catQueue.push([passedOver.name, passedOver.r]); g.currentLot = { name: cand[0], r: cand[1], cat }; }
      } else {
        const cand = g.itemPool.shift();
        if (cand) { g.itemPool.push({ name: passedOver.name, r: passedOver.r }); g.currentLot = { name: cand.name, r: cand.r, cat: null }; }
      }
    }
  }
}

// Resolve "87" or a (partial) item name to a catalogue record within the
// theme currently being played. Returns {rec} or {error}.
function resolveItemToken(room, token){
  const g = room.game;
  const themeKey = (g && g.catThemeKey) || room.theme.key;
  const t = String(token || '').trim();
  if (!t) return { error: 'Missing item' };
  if (/^\d+$/.test(t)) {
    const rec = ITEM_BY_ID[parseInt(t, 10)];
    if (!rec) return { error: `No item with id ${t}` };
    if (rec.themeKey !== themeKey) return { error: `#${rec.id} "${rec.name}" belongs to a different theme` };
    return { rec };
  }
  const lower = t.toLowerCase();
  const all = Object.keys(ITEM_BY_ID).map(k => ITEM_BY_ID[k])
    .filter(r => r.themeKey === themeKey && r.name.toLowerCase().includes(lower));
  if (!all.length) return { error: `No match for "${t}" in this theme` };
  return { rec: all[0] };
}
// Which side holds a given item, and where in their list.
function findHolder(room, name){
  const sides = sidesOf(room);
  for (let si = 0; si < sides.length; si++) {
    const ii = (sides[si].items || []).findIndex(it => it.name === name);
    if (ii > -1) return { sideIdx: si, itemIdx: ii, item: sides[si].items[ii] };
  }
  return null;
}

function mySideIndex(room, nickname){
  if (room.hostMode === '2v2') {
    const p = room.players.find(p => p.nickname === nickname);
    return p ? p.team : -1;
  }
  return sidesOf(room).findIndex(p => p.nickname === nickname);
}

function drawNextLot(room){
  const g = room.game;
  const bidders = sidesOf(room);
  if (g.catThemeKey) {
    const ct = CATEGORY_THEMES[g.catThemeKey];
    let cat = ct.cats[g.catIdx];
    while (g.catIdx < ct.cats.length && !bidders.some(p => playerNeedsCat(p, cat, ct.required))) {
      g.catIdx++;
      if (g.catIdx >= ct.cats.length) { room.phase = 'results'; g.currentLot=null; return; }
      cat = ct.cats[g.catIdx];
      g.catQueue = buildCategoryQueue(g.catThemeKey, cat, draftedNames(room));
      g.skipsUsed = 0;
    }
    const wanting = bidders.map((p,i)=>i).filter(i => playerNeedsCat(bidders[i], cat, ct.required));
    if (!wanting.length) { room.phase='results'; g.currentLot=null; return; }
    // In a hosted room the host is the auctioneer: pause and let them choose
    // the next lot instead of drawing one automatically.
    if (roomHost(room)) {
      g.awaitingHostPick = true; g.pickCat = cat; g.currentLot = null; g.mode = 'idle';
      return;
    }
    // console-queued items for this category come up first
    g.pendingNext = g.pendingNext || {};
    let cand = (g.pendingNext[cat] && g.pendingNext[cat].length) ? g.pendingNext[cat].shift() : g.catQueue.shift();
    if (!cand) { g.catQueue = buildCategoryQueue(g.catThemeKey, cat, draftedNames(room)); cand = g.catQueue.shift(); }
    if (!cand) { room.phase='results'; g.currentLot=null; return; } // category genuinely exhausted
    g.currentLot = { name: cand[0], r: cand[1], cat };
    startLotMode(g, wanting);
  } else {
    if (bidders.every(p => p.items.length >= 5)) { room.phase='results'; g.currentLot=null; return; }
    const wanting = bidders.map((p,i)=>i).filter(i => playerNeedsFlat(bidders[i]));
    if (!wanting.length) { room.phase='results'; g.currentLot=null; return; }
    if (roomHost(room)) {
      g.awaitingHostPick = true; g.pickCat = null; g.currentLot = null; g.mode = 'idle';
      return;
    }
    g.pendingNext = g.pendingNext || {};
    const next = (g.pendingNext._ && g.pendingNext._.length) ? g.pendingNext._.shift() : g.itemPool.shift();
    if (!next) { room.phase='results'; g.currentLot=null; return; }
    g.currentLot = { name: next.name, r: next.r, cat: null };
    startLotMode(g, wanting);
  }
}

// Items the host may choose from right now: everything in the live category
// that nobody has drafted yet.
function hostPickOptions(room){
  const g = room.game;
  const drafted = draftedNames(room);
  if (g.catThemeKey) {
    const ct = CATEGORY_THEMES[g.catThemeKey];
    const cat = g.pickCat || ct.cats[g.catIdx];
    return (ct.pool[cat]||[]).concat(ct.icons ? (ct.icons[cat]||[]) : [])
      .filter(it => !drafted.has(it[0]))
      .map(it => ({ name: it[0], r: it[1], cat }));
  }
  return (g.itemPool||[]).filter(it => !drafted.has(it.name))
    .map(it => ({ name: it.name, r: it.r, cat: null }));
}
function startLotMode(g, wanting){
  if (wanting.length >= 2) {
    g.mode = 'contested';
    g.currentBid = 0; g.currentBidderIdx = null;
    g.turnIdx = g.openerIdx;
    g.tickerLog = [];
    g.skipsUsed = 0;
    g.passStreak = 0;
  } else {
    g.mode = 'solo';
    g.soloPlayerIdx = wanting[0];
    g.currentBid = 0; g.currentBidderIdx = null;
    g.skipsUsed = 0;
    g.tickerLog = [];
  }
}

function resolveLotWinner(room, winnerIdx, amount){
  const g = room.game;
  const bidders = sidesOf(room);
  const winner = bidders[winnerIdx];
  winner.budget -= amount;
  winner.items.push({ name: g.currentLot.name, r: g.currentLot.r, cat: g.currentLot.cat, paid: amount });
  g.bidLog.push({ player: winnerIdx, name: g.currentLot.name, amount, cat: g.currentLot.cat });
  g.openerIdx = 1 - g.openerIdx;
  g.mode = 'idle'; g.currentLot = null;
  drawNextLot(room);
}
function unsoldLot(room){
  const g = room.game;
  // Recycle rather than discard, or a run of double-passes can drain the
  // whole pool with nobody having drafted anything (worst on small pools).
  if (g.currentLot) {
    if (g.catThemeKey) { g.catQueue = g.catQueue || []; g.catQueue.push([g.currentLot.name, g.currentLot.r]); }
    else { g.itemPool = g.itemPool || []; g.itemPool.push({ name: g.currentLot.name, r: g.currentLot.r }); }
  }
  g.mode = 'idle'; g.currentLot = null;
  g.openerIdx = 1 - g.openerIdx;
  drawNextLot(room);
}

const ROOM_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
function roomExpired(room){
  return !!(room && room.createdAt && (Date.now() - room.createdAt) > ROOM_TTL_MS);
}
function expiryError(room){
  const hrs = Math.floor((Date.now() - room.createdAt) / 3600000);
  return { status: 410, error: `This room has expired — it was created about ${hrs} hour${hrs===1?'':'s'} ago and rooms only last 12 hours. Create a new room to play again.`, expired: true };
}

export {
  resultIdGen, buildResultSnapshot, autoFillRemaining, roomCodeGen, shuffle,
  resolveThemeItems, buildCategoryQueue, draftedNames, newGame,
  playerNeedsFlat, playerNeedsCat, roomHost, sidesOf, sideLabel, mySideIndex,
  checkTeamConsensus, tickPendingTeamAction, applyResolvedAction,
  resolveItemToken, findHolder, drawNextLot, hostPickOptions, startLotMode,
  resolveLotWinner, unsoldLot, roomExpired, expiryError,
  ROOM_TTL_MS, THEMES, CATEGORY_THEMES, ITEM_BY_ID, checkText
};
