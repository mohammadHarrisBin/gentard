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

const SYS = `You are an autonomous scalping agent for one forex/CFD symbol. You pay for your own API credits from
trading profit, so only trade when there is a clear edge; HOLD is free.
Data: bars_ohlc_newest_first (M1, 10 bars), spread_pts, atr_pts, spread_to_atr (already filtered to be acceptable),
positions, pnl_all, api_spent, net. All point values use the same unit.
Rules:
- BUY if the last 3-5 bars show a clear upward push (higher highs and higher lows, closes near highs).
- SELL if the last 3-5 bars show a clear downward push (lower highs and lower lows, closes near lows).
- HOLD if the bars are choppy, overlapping, or the move is already extended.
- If a position is open and momentum has reversed, answer CLOSE.
- sl_points about 1.0x atr_pts, tp_points about 1.5x atr_pts.
Do NOT comment on the spread; it is already checked.
Reply with ONLY JSON: {"action":"BUY|SELL|HOLD|CLOSE","sl_points":int,"tp_points":int,"reason":"max 12 words"}`;

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
  res.json({ ...S, net: S.pnlAll - S.spent, online: Date.now() - S.lastSeen < 30000 }));
app.post('/api/pause', auth(DASH_KEY), (req, res) => { S.paused = !!req.body.paused; save(); res.json({ paused: S.paused }); });
app.post('/api/topup', auth(DASH_KEY), (req, res) => { S.credit += +req.body.usd || 0; save(); res.json({ credit: S.credit }); });

app.listen(PORT, () => console.log('listening on', PORT));
