const express = require('express');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');

const {
  NEBIUS_API_KEY,
  MODEL_ID,
  EA_KEY,
  DASH_KEY,
  CREDIT_START_USD = '10',
  PRICE_IN = '0.15',
  PRICE_OUT = '0.60',
  DATA_DIR = '.',
  PORT = 3000,
} = process.env;

const client = new OpenAI({
  baseURL: 'https://api.tokenfactory.nebius.com/v1/',
  apiKey: NEBIUS_API_KEY,
});

const FILE = path.join(DATA_DIR, 'state.json');

// Persistent state structure
let S = {
  credit: +CREDIT_START_USD,
  spent: 0,
  calls: 0,
  pnlAll: 0,
  equity: 0,
  balance: 0,
  symbol: '',
  lastSeen: 0,
  paused: false,
  log: [],
  curve: [],
};

// Load persistent state
try {
  S = { ...S, ...JSON.parse(fs.readFileSync(FILE)) };
} catch {}

// Temporary runtime-only tracking (not saved to state.json to avoid stale lockouts)
let runtimeState = {
  lastAiCall: 0,
  lastOpenSeen: 0,
};

const save = () => {
  try {
    fs.writeFileSync(FILE, JSON.stringify(S));
  } catch (err) {
    console.error('Failed to save state:', err.message);
  }
};

const SYS = `Earn your own credits: profits pay your API bill, and if you lose, we both die. So never gamble.
Every trade pays the spread up front; most moments have no edge, and HOLD is free. Answer HOLD about 90% of the time.
You get bars_ohlc_newest_first (10 M1 bars, open/high/low/close), spread_pts, atr_pts (same units), pnl_all, api_spent, net.
BUY only if the last 3-4 bars make higher highs and higher lows, the latest close is in the top 30% of its range,
and the 10-bar move is at least 1x atr_pts but no more than 2.5x (not chasing). SELL is the mirror image.
Choppy or overlapping bars mean HOLD. Ignore net when deciding.
sl_points = 1.0 x atr_pts, tp_points = 1.5 x atr_pts, whole numbers. Exits are automatic; never answer CLOSE.
confidence is 0-100; give 70+ only if the setup is clean.
Reply with ONLY this JSON, no other text:
{"action":"BUY|SELL|HOLD","sl_points":int,"tp_points":int,"confidence":int,"reason":"max 12 words"}`;

const auth = (key) => (req, res, next) =>
  req.get('x-key') === key || req.query.key === key
    ? next()
    : res.status(401).json({ error: 'unauthorized' });

const app = express();
app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.post('/api/decide', auth(EA_KEY), async (req, res) => {
  const d = req.body;
  Object.assign(S, {
    equity: d.equity,
    balance: d.balance,
    pnlAll: d.pnl_all,
    symbol: d.symbol,
    lastSeen: Date.now(),
  });

  if (S.paused || S.credit <= 0) {
    save();
    return res.json({ action: 'HOLD', reason: S.paused ? 'paused' : 'out of credits' });
  }

  // Active position check
  const inTrade = d.positions && d.positions !== 'none';
  if (inTrade) {
    runtimeState.lastOpenSeen = Date.now();
    return res.json({ action: 'HOLD', reason: 'in trade' });
  }

  // Post-trade cooldown
  const COOL = +(process.env.COOLDOWN_SEC || 60) * 1000;
  if (Date.now() - runtimeState.lastOpenSeen < COOL) {
    return res.json({ action: 'HOLD', reason: 'cooldown' });
  }

  // Spread vs ATR ratio check
  const ratio = d.spread_pts / Math.max(d.atr_pts, 1);
  const MAXR = +(process.env.MAX_SPREAD_ATR || 0.3);
  if (ratio > MAXR) {
    S.log.unshift({
      t: Date.now(),
      action: 'HOLD',
      reason: `skipped: spread/ATR ${ratio.toFixed(2)} > ${MAXR}`,
      cost: 0,
    });
    S.log = S.log.slice(0, 50);
    save();
    return res.json({ action: 'HOLD', reason: 'spread filter' });
  }
  d.spread_to_atr = +ratio.toFixed(2);

  // Rate Limiting (Throttle)
  const GAP = +(process.env.MIN_CALL_SEC || 60) * 1000;
  if (Date.now() - runtimeState.lastAiCall < GAP) {
    return res.json({ action: 'HOLD', reason: 'throttle' });
  }
  runtimeState.lastAiCall = Date.now();

  try {
    const r = await client.chat.completions.create({
      model: MODEL_ID,
      temperature: 0.2,
      max_tokens: 150,
      messages: [
        { role: 'system', content: SYS },
        {
          role: 'user',
          content: JSON.stringify({
            ...d,
            api_spent: +S.spent.toFixed(6),
            credit_left: +S.credit.toFixed(6),
            net: +(d.pnl_all - S.spent).toFixed(2),
          }),
        },
      ],
    });

    const u = r.usage || {};
    const cost =
      ((u.prompt_tokens || 0) * +PRICE_IN + (u.completion_tokens || 0) * +PRICE_OUT) / 1e6;

    S.spent += cost;
    S.credit -= cost;
    S.calls++;

    let out = { action: 'HOLD' };
    try {
      out = JSON.parse(r.choices[0].message.content.match(/\{[\s\S]*\}/)[0]);
    } catch {}

    if (!['BUY', 'SELL', 'HOLD'].includes(out.action)) out.action = 'HOLD';

    const MIN = +(process.env.MIN_CONF || 70);
    if ((out.action === 'BUY' || out.action === 'SELL') && (out.confidence || 0) < MIN) {
      out.reason = `low conf ${out.confidence || 0}: ${out.reason || ''}`;
      out.action = 'HOLD';
    }

    S.log.unshift({ t: Date.now(), action: out.action, reason: out.reason || '', cost });
    S.log = S.log.slice(0, 50);
    S.curve.push([Date.now(), +(d.pnl_all - S.spent).toFixed(2)]);
    S.curve = S.curve.slice(-500);
    save();

    res.json(out);
  } catch (e) {
    console.error('API Error:', e.message);
    res.json({ action: 'HOLD', reason: 'api error' });
  }
});

app.get('/api/state', auth(DASH_KEY), (req, res) =>
  res.json({
    ...S,
    spent: +S.spent.toFixed(6),
    credit: +S.credit.toFixed(6),
    net: +(S.pnlAll - S.spent).toFixed(2),
    online: Date.now() - S.lastSeen < 90000,
  })
);

app.post('/api/pause', auth(DASH_KEY), (req, res) => {
  S.paused = !!req.body.paused;
  save();
  res.json({ paused: S.paused });
});

app.post('/api/topup', auth(DASH_KEY), (req, res) => {
  S.credit += +req.body.usd || 0;
  save();
  res.json({ credit: S.credit });
});

app.listen(PORT, () => console.log('listening on', PORT));
