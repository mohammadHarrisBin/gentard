const express = require('express');
const OpenAI = require('openai');
const fs = require('fs');
const { NEBIUS_API_KEY, MODEL_ID, EA_KEY, DASH_KEY, CREDIT_START_USD = '10',
        PRICE_IN = '0.15', PRICE_OUT = '0.60', DATA_DIR = '.', PORT = 3000 } = process.env;

const client = new OpenAI({ baseURL: 'https://api.tokenfactory.nebius.com/v1/', apiKey: NEBIUS_API_KEY });
const FILE = DATA_DIR + '/state.json';
let S = { credit: +CREDIT_START_USD, spent: 0, calls: 0, pnlAll: 0, equity: 0, balance: 0,
          symbol: '', lastSeen: 0, paused: false, log: [], curve: [] };
try { S = { ...S, ...JSON.parse(fs.readFileSync(FILE)) }; } catch {}
const save = () => { try { fs.writeFileSync(FILE, JSON.stringify(S)); } catch {} };

const SYS = `You are an autonomous scalping agent trading one forex symbol, and your survival depends on profit.
Your API calls are paid from your own trading profits. If net (pnl_all minus api_spent) trends negative you are shut down
and you die. Every trade also pays the spread up front, so a trade is only worth taking if its expected profit clearly
beats the spread plus your running costs. Most moments have no edge. Doing nothing is free and keeps you alive: you should
answer HOLD about 90% of the time. A missed trade costs nothing; a bad trade costs real money.

Data you receive: bars_ohlc_newest_first (10 one-minute bars as open/high/low/close, newest first), spread_pts, atr_pts,
spread_to_atr (already checked, do not comment on it), pnl_all, api_spent, credit_left, net. All price distances are in points.

Only trade when ALL of these hold:
1. Direction: the 10-bar sequence has a clear drift (net move at least 1x atr_pts) and the last 3 closes agree with it.
2. Structure: BUY needs higher highs and higher lows over the last 3-4 bars; SELL needs lower highs and lower lows.
3. Strength: the latest bar closes in the top 30% of its range for BUY, or the bottom 30% for SELL.
4. Not exhausted: the move from the oldest bar to now is no more than 2.5x atr_pts. If it is bigger, you would be chasing, so HOLD.
5. Not choppy: overlapping bars, tiny ranges, or alternating up/down bars mean HOLD.

Risk and survival:
- sl_points = 1.0 x atr_pts, tp_points = 1.5 x atr_pts, as whole numbers.
- If net is negative, be stricter and trade less. If net is positive, stay disciplined; never chase or take bigger risks.
- Exits are handled automatically by stop loss, take profit and a time limit. Never answer CLOSE.
- confidence is 0-100. Give 70 or more only if all five conditions are clearly met. When unsure, HOLD with a low number.

Reply with ONLY one JSON object, no other text:
{"action":"BUY|SELL|HOLD","sl_points":int,"tp_points":int,"confidence":int,"reason":"max 12 words"}`;

const auth = (key) => (req, res, next) =>
  (req.get('x-key') === key || req.query.key === key) ? next() : res.status(401).json({ error: 'unauthorized' });

const app = express();
app.use(express.json({ limit: '200kb' }));

const path = require('path');
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.post('/api/decide', auth(EA_KEY), async (req, res) => {
  const d = req.body;
  Object.assign(S, { equity: d.equity, balance: d.balance, pnlAll: d.pnl_all, symbol: d.symbol, lastSeen: Date.now() });
  if (S.paused || S.credit <= 0) {
    save();
    return res.json({ action: 'HOLD', reason: S.paused ? 'paused' : 'out of credits' });
  }

        // don't ask the AI while a trade is open: SL/TP/time-stop handle exits
const inTrade = d.positions && d.positions !== 'none';
if (inTrade) {
  S.lastOpenSeen = Date.now();
  return res.json({ action: 'HOLD', reason: 'in trade' });
}
// cooldown after a trade closes, to stop BUY/CLOSE churn
const COOL = +(process.env.COOLDOWN_SEC || 60) * 1000;
if (Date.now() - (S.lastOpenSeen || 0) < COOL) {
  return res.json({ action: 'HOLD', reason: 'cooldown' });
}

  // spread filter: skip the AI call (and its cost) when spread is too big vs ATR
  const ratio = d.spread_pts / Math.max(d.atr_pts, 1);
  const MAXR = +(process.env.MAX_SPREAD_ATR || 0.3);
  if (ratio > MAXR) {
    S.log.unshift({ t: Date.now(), action: 'HOLD', reason: `skipped: spread/ATR ${ratio.toFixed(2)} > ${MAXR}`, cost: 0 });
    S.log = S.log.slice(0, 50);
    save();
    return res.json({ action: 'HOLD', reason: 'spread filter' });
  }
  d.spread_to_atr = +ratio.toFixed(2);

        
  try {
    const r = await client.chat.completions.create({
      model: MODEL_ID, temperature: 0.2, max_tokens: 150,
      messages: [{ role: 'system', content: SYS },
                 { role: 'user', content: JSON.stringify({ ...d, api_spent: +S.spent.toFixed(4),
                     credit_left: +S.credit.toFixed(4), net: +(d.pnl_all - S.spent).toFixed(2) }) }],
    });
    const u = r.usage || {};
    const cost = ((u.prompt_tokens || 0) * +PRICE_IN + (u.completion_tokens || 0) * +PRICE_OUT) / 1e6;
    S.spent += cost; S.credit -= cost; S.calls++;
    let out = { action: 'HOLD' };
    try { out = JSON.parse(r.choices[0].message.content.match(/\{[\s\S]*\}/)[0]); } catch {}
    if (!['BUY', 'SELL', 'HOLD', 'CLOSE'].includes(out.action)) out.action = 'HOLD';
    if ((out.action === 'BUY' || out.action === 'SELL') && (out.confidence || 0) < +(process.env.MIN_CONF || 70)) out.action = 'HOLD';
    S.log.unshift({ t: Date.now(), action: out.action, reason: out.reason || '', cost });
    S.log = S.log.slice(0, 50);
    S.curve.push([Date.now(), +(d.pnl_all - S.spent).toFixed(2)]);
    S.curve = S.curve.slice(-500);
    save();
    res.json(out);
  } catch (e) {
    console.error(e.message);
    res.json({ action: 'HOLD', reason: 'api error' });
  }
});

app.get('/api/state', auth(DASH_KEY), (req, res) =>
  res.json({ ...S, net: S.pnlAll - S.spent, online: Date.now() - S.lastSeen < 90000 }));
app.post('/api/pause', auth(DASH_KEY), (req, res) => { S.paused = !!req.body.paused; save(); res.json({ paused: S.paused }); });
app.post('/api/topup', auth(DASH_KEY), (req, res) => { S.credit += +req.body.usd || 0; save(); res.json({ credit: S.credit }); });

app.listen(PORT, () => console.log('listening on', PORT));
