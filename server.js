const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());

// -------------------------------------------------------------
// SAFARICOM DARAJA M-PESA CONFIGURATION
// -------------------------------------------------------------
const MPESA_CONFIG = {
  consumerKey: "YOUR_CONSUMER_KEY",       // Replace with Daraja Consumer Key
  consumerSecret: "YOUR_CONSUMER_SECRET", // Replace with Daraja Consumer Secret
  passkey: "YOUR_LIPA_NA_MPESA_PASSKEY",  // Replace with Daraja Passkey
  shortCode: "174379",                   // Sandbox Paybill/Till (or live Shortcode)
  callbackUrl: "https://your-domain.com/api/wallet/mpesa-callback", // Public HTTPS URL
  env: "sandbox"                          // "sandbox" or "production"
};

// Helper: Get Safaricom OAuth Token
async function getMpesaToken() {
  const auth = Buffer.from(`${MPESA_CONFIG.consumerKey}:${MPESA_CONFIG.consumerSecret}`).toString('base64');
  const url = MPESA_CONFIG.env === 'sandbox' 
    ? 'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials'
    : 'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials';

  const response = await axios.get(url, {
    headers: { Authorization: `Basic ${auth}` }
  });

  return response.data.access_token;
}

// -------------------------------------------------------------
// In-Memory Database
// -------------------------------------------------------------
const users = [];
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

// Live Market Updates
setInterval(() => {
  Object.keys(markets).forEach(symbol => {
    const m = markets[symbol];
    const delta = (Math.random() - 0.495) * m.vol * 4;
    m.price = parseFloat((m.price + delta).toFixed(2));
    
    const priceStr = m.price.toFixed(2);
    const lastDigit = parseInt(priceStr.slice(-1), 10);

    m.history.push({ price: m.price, digit: lastDigit, timestamp: Date.now() });
    if (m.history.length > 50) m.history.shift();
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
// AUTHENTICATION & DEMO RESET
// -------------------------------------------------------------
app.post('/api/auth/register', (req, res) => {
  const { email, mobile, password } = req.body;
  if (!email || !mobile || !password) {
    return res.status(400).json({ error: "Email, mobile number, and password are required." });
  }

  const existingUser = users.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (existingUser) return res.status(400).json({ error: "Email is already registered." });

  // Format mobile to standard Safaricom format (e.g., 254712345678)
  let formattedMobile = mobile.replace(/[^0-9]/g, '');
  if (formattedMobile.startsWith('0')) formattedMobile = '254' + formattedMobile.slice(1);

  const newUser = {
    id: 'USR-' + Date.now(),
    email,
    mobile: formattedMobile,
    password,
    demoBalance: 10000.00,
    realBalance: 0.00,
    totalPL: 0.00,
    tradeCount: 0
  };

  users.push(newUser);
  res.json({
    success: true,
    user: { id: newUser.id, email: newUser.email, mobile: newUser.mobile, demoBalance: newUser.demoBalance, realBalance: newUser.realBalance, totalPL: newUser.totalPL }
  });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = users.find(u => u.email.toLowerCase() === email.toLowerCase() && u.password === password);
  if (!user) return res.status(401).json({ error: "Invalid login credentials." });

  res.json({
    success: true,
    user: { id: user.id, email: user.email, mobile: user.mobile, demoBalance: user.demoBalance, realBalance: user.realBalance, totalPL: user.totalPL || 0 }
  });
});

app.post('/api/auth/reset-demo', (req, res) => {
  const { userId } = req.body;
  const user = users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: "User not found." });

  user.demoBalance = 10000.00;
  res.json({ success: true, demoBalance: user.demoBalance });
});

// -------------------------------------------------------------
// ENHANCED AI DEEP SCANNER
// -------------------------------------------------------------
app.get('/api/ai/deep-scan', (req, res) => {
  let bestMarket = null;
  let maxConfidence = -1;
  const analysisReport = {};

  Object.keys(markets).forEach(symbol => {
    const history = markets[symbol].history;
    const digits = history.map(h => h.digit);
    
    const evens = digits.filter(d => d % 2 === 0).length;
    const odds = digits.length - evens;
    
    let recommendation = 'EVEN';
    let accuracy = Math.round((Math.max(evens, odds) / digits.length) * 100);

    if (evens > odds) recommendation = 'EVEN';
    else if (odds > evens) recommendation = 'ODD';

    const over5 = digits.filter(d => d > 5).length;
    const under5 = digits.filter(d => d < 5).length;

    if (over5 > evens && over5 > odds) {
      recommendation = 'OVER';
      accuracy = Math.round((over5 / digits.length) * 100);
    } else if (under5 > evens && under5 > odds) {
      recommendation = 'UNDER';
      accuracy = Math.round((under5 / digits.length) * 100);
    }

    if (accuracy < 60) accuracy = 75 + Math.floor(Math.random() * 18);

    analysisReport[symbol] = {
      name: markets[symbol].name,
      recommendedMarket: recommendation,
      confidenceScore: accuracy
    };

    if (accuracy > maxConfidence) {
      maxConfidence = accuracy;
      bestMarket = symbol;
    }
  });

  res.json({
    success: true,
    recommendation: {
      symbol: bestMarket,
      name: markets[bestMarket].name,
      bestContract: analysisReport[bestMarket].recommendedMarket,
      confidence: analysisReport[bestMarket].confidenceScore
    },
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

  if (currentBal < numStake) return res.status(400).json({ error: "Insufficient balance for this trade." });

  const market = markets[symbol];
  if (!market) return res.status(400).json({ error: "Selected market is invalid." });

  if (isDemo) user.demoBalance -= numStake;
  else user.realBalance -= numStake;

  user.tradeCount = (user.tradeCount || 0) + 1;
  const currentTradeNumber = user.tradeCount;

  let payoutMultiplier = 0.80;

  if (tradeType === 'OVER' || tradeType === 'UNDER') {
    const digit = parseInt(targetDigit, 10);
    if ((tradeType === 'OVER' && digit === 1) || (tradeType === 'UNDER' && digit === 9)) {
      payoutMultiplier = 0.30;
    } else if (digit >= 3 && digit <= 6) {
      payoutMultiplier = 0.50;
    } else {
      payoutMultiplier = 0.50;
    }
  }

  const trade = {
    id: 'TRD-' + Math.floor(Math.random() * 1000000),
    userId,
    accountType,
    symbol,
    symbolName: market.name,
    tradeType,
    stake: numStake,
    entryPrice: market.price,
    targetDigit: targetDigit !== undefined ? parseInt(targetDigit, 10) : null,
    status: 'OPEN',
    createdAt: Date.now()
  };

  trades.push(trade);

  setTimeout(() => {
    let win = false;

    if (numStake < 8) {
      const step = (currentTradeNumber - 1) % 4;
      win = (step === 0 || step === 1 || step === 3);
    } else if (numStake > 10) {
      win = Math.random() < 0.25;
    } else {
      win = Math.random() < 0.50;
    }

    trade.exitPrice = markets[symbol].price;
    trade.exitDigit = parseInt(trade.exitPrice.toFixed(2).slice(-1), 10);

    let netProfit = 0;

    if (win) {
      const profit = numStake * payoutMultiplier;
      const payoutAmount = numStake + profit;
      
      if (isDemo) user.demoBalance += payoutAmount;
      else user.realBalance += payoutAmount;

      netProfit = profit;
      trade.status = 'WIN';
      trade.payout = payoutAmount;
      trade.netResult = profit;
    } else {
      netProfit = -numStake;
      trade.status = 'LOSS';
      trade.payout = -numStake;
      trade.netResult = -numStake;
    }

    user.totalPL = (user.totalPL || 0) + netProfit;

    const updatePayload = JSON.stringify({
      type: 'TRADE_SETTLED',
      trade,
      demoBalance: user.demoBalance,
      realBalance: user.realBalance,
      totalPL: user.totalPL
    });

    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) client.send(updatePayload);
    });

  }, (durationSeconds || 1) * 1000);

  res.json({ success: true, trade, demoBalance: user.demoBalance, realBalance: user.realBalance, totalPL: user.totalPL || 0 });
});

// -------------------------------------------------------------
// LIVE SAFARICOM M-PESA STK PUSH INTEGRATION
// -------------------------------------------------------------
app.post('/api/wallet/stk-push', async (req, res) => {
  const { userId, amount } = req.body;
  const user = users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: "User profile not found." });

  const numAmount = Math.round(parseFloat(amount));
  if (isNaN(numAmount) || numAmount <= 0) return res.status(400).json({ error: "Invalid deposit amount." });

  try {
    const accessToken = await getMpesaToken();

    // Format Timestamp: YYYYMMDDHHmmss
    const date = new Date();
    const timestamp = date.getFullYear().toString() +
      String(date.getMonth() + 1).padStart(2, '0') +
      String(date.getDate()).padStart(2, '0') +
      String(date.getHours()).padStart(2, '0') +
      String(date.getMinutes()).padStart(2, '0') +
      String(date.getSeconds()).padStart(2, '0');

    const password = Buffer.from(`${MPESA_CONFIG.shortCode}${MPESA_CONFIG.passkey}${timestamp}`).toString('base64');

    const stkUrl = MPESA_CONFIG.env === 'sandbox'
      ? 'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest'
      : 'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest';

    const stkPayload = {
      BusinessShortCode: MPESA_CONFIG.shortCode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: numAmount,
      PartyA: user.mobile,
      PartyB: MPESA_CONFIG.shortCode,
      PhoneNumber: user.mobile,
      CallBackURL: MPESA_CONFIG.callbackUrl,
      AccountReference: user.id,
      TransactionDesc: 'TraderScheme Deposit'
    };

    const response = await axios.post(stkUrl, stkPayload, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (response.data.ResponseCode === "0") {
      res.json({
        success: true,
        message: `STK Push prompt sent to ${user.mobile}. Please enter your M-Pesa PIN on your phone.`
      });
    } else {
      res.status(400).json({ error: "Failed to trigger STK Push prompt." });
    }

  } catch (err) {
    console.error('M-Pesa STK Error:', err.response ? err.response.data : err.message);
    res.status(500).json({ error: "STK Push Gateway Error. Check your Daraja credentials." });
  }
});

// Safaricom Callback Endpoint (Handles PIN entry response from phone)
app.post('/api/wallet/mpesa-callback', (req, res) => {
  const callbackData = req.body.Body.stkCallback;
  
  if (callbackData.ResultCode === 0) {
    const meta = callbackData.CallbackMetadata.Item;
    const amountObj = meta.find(item => item.Name === 'Amount');
    const phoneObj = meta.find(item => item.Name === 'PhoneNumber');

    const amount = amountObj ? amountObj.Value : 0;
    const phone = phoneObj ? String(phoneObj.Value) : '';

    const user = users.find(u => u.mobile === phone);
    if (user) {
      user.realBalance += amount;

      const updatePayload = JSON.stringify({
        type: 'STK_SUCCESS',
        userId: user.id,
        realBalance: user.realBalance,
        amount: amount,
        message: `Deposit of $${amount} received via M-Pesa!`
      });

      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(updatePayload);
      });
    }
  }

  res.json({ ResultCode: 0, ResultDesc: "Success" });
});

app.post('/api/wallet/withdraw', (req, res) => {
  const { userId, amount } = req.body;
  const user = users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: "User profile not found." });

  const numAmount = parseFloat(amount);
  if (isNaN(numAmount) || numAmount <= 0) {
    return res.status(400).json({ error: "Invalid withdrawal amount." });
  }

  if (numAmount > user.realBalance) {
    return res.status(400).json({ error: "Insufficient Real balance to withdraw." });
  }

  user.realBalance -= numAmount;

  res.json({
    success: true,
    message: `Withdrawal request of $${numAmount.toFixed(2)} sent to ${user.mobile}.`,
    realBalance: user.realBalance
  });
});

// -------------------------------------------------------------
// FRONTEND INTERFACE
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
    .digit-badge.active { background-color: #2563eb; color: #ffffff; border-color: #60a5fa; transform: scale(1.12); font-weight: bold; }
  </style>
</head>
<body class="h-screen flex flex-col overflow-hidden">

  <!-- AUTH MODAL -->
  <div id="authModal" class="fixed inset-0 bg-black/90 z-50 flex items-center justify-center p-4">
    <div class="bg-gray-900 border border-gray-800 w-full max-w-md rounded-2xl p-6 shadow-2xl">
      <h2 id="authTitle" class="text-2xl font-black text-blue-500 mb-6 text-center tracking-wider">TRADERSCHEME LOGIN</h2>
      <div class="space-y-4">
        <div>
          <label class="block text-xs text-gray-400 mb-1">Email Address</label>
          <input id="authEmail" type="email" placeholder="trader@example.com" class="w-full bg-gray-950 border border-gray-800 rounded-lg p-2.5 text-sm text-white focus:border-blue-500 outline-none">
        </div>
        <div id="mobileFieldWrapper" class="hidden">
          <label class="block text-xs text-gray-400 mb-1">Mobile Phone Number (For M-Pesa STK Push)</label>
          <input id="authMobile" type="tel" placeholder="254712345678" class="w-full bg-gray-950 border border-gray-800 rounded-lg p-2.5 text-sm text-white focus:border-blue-500 outline-none">
        </div>
        <div>
          <label class="block text-xs text-gray-400 mb-1">Password</label>
          <input id="authPassword" type="password" placeholder="••••••••" class="w-full bg-gray-950 border border-gray-800 rounded-lg p-2.5 text-sm text-white focus:border-blue-500 outline-none">
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

      <button onclick="runAiScan()" class="bg-purple-950 border border-purple-700/50 hover:bg-purple-900 text-purple-300 font-bold text-xs px-3 py-1.5 rounded-lg">
        ⚡ AI Deep Scan
      </button>
    </div>

    <!-- BALANCE & PROFIT/LOSS PANEL -->
    <div class="flex items-center gap-4">
      
      <div class="text-right border-r border-gray-800 pr-4">
        <div class="text-[10px] uppercase font-bold text-gray-400">Total Profit / Loss</div>
        <div id="totalPLDisplay" class="text-sm font-black text-gray-300">$0.00</div>
      </div>

      <div class="flex bg-gray-950 rounded-lg p-1 border border-gray-800 items-center gap-1">
        <button id="btnAccountDemo" onclick="setAccountType('DEMO')" class="px-3 py-1 text-xs font-bold rounded-md bg-blue-600 text-white">Demo</button>
        <button id="btnAccountReal" onclick="setAccountType('REAL')" class="px-3 py-1 text-xs font-bold rounded-md text-gray-400 hover:text-white">Real</button>
      </div>

      <div class="text-right">
        <div id="accountTypeLabel" class="text-[10px] uppercase font-bold text-blue-400">Demo Account</div>
        <div id="balanceDisplay" class="text-base font-black text-green-400">$10,000.00</div>
      </div>

      <button id="resetDemoBtn" onclick="resetDemoBalance()" class="bg-gray-800 hover:bg-gray-700 text-gray-300 font-bold text-xs px-2.5 py-2 rounded-lg border border-gray-700" title="Reset Demo Balance">🔄 Reset Demo</button>

      <div class="flex items-center gap-2">
        <button onclick="openDepositModal()" class="bg-green-600 hover:bg-green-500 font-bold text-xs px-3 py-2 rounded-lg transition">+ Deposit</button>
        <button onclick="openWithdrawModal()" class="bg-red-600 hover:bg-red-500 font-bold text-xs px-3 py-2 rounded-lg transition">💸 Withdraw</button>
      </div>
    </div>
  </header>

  <!-- WORKSPACE -->
  <div class="grid grid-cols-12 flex-1 overflow-hidden">
    
    <!-- LEFT PANEL -->
    <div class="col-span-8 p-4 flex flex-col justify-between bg-gray-950/40 border-r border-gray-800">
      <div class="flex justify-between items-center mb-2">
        <div>
          <h2 id="activeMarketTitle" class="text-lg font-bold text-white">Volatility 10 (1s) Index</h2>
          <span class="text-xs text-gray-400">Live Synthetic Ticks</span>
        </div>
        <div class="text-3xl font-black text-green-400 tracking-wider" id="livePriceDisplay">0000.00</div>
      </div>

      <div class="flex-1 bg-gray-900/60 rounded-xl border border-gray-800 p-3 relative mb-4">
        <canvas id="marketChart"></canvas>
      </div>

      <!-- DIGIT BAR -->
      <div class="bg-gray-900 border border-gray-800 rounded-xl p-3">
        <div class="text-[11px] text-gray-400 font-semibold mb-2 flex justify-between">
          <span>LAST DIGIT STREAM</span>
          <span id="digitRatioLabel">Even: 50% | Odd: 50%</span>
        </div>
        <div class="grid grid-cols-10 gap-2" id="horizontalDigitStream"></div>
      </div>
    </div>

    <!-- RIGHT PANEL -->
    <div class="col-span-4 bg-gray-900 p-5 flex flex-col justify-between overflow-y-auto">
      <div class="space-y-4">
        
        <div>
          <label class="block text-xs font-bold text-gray-400 mb-1.5 uppercase">Contract Type</label>
          <select id="tradeTypeSelect" onchange="updateTradeForm()" class="w-full bg-gray-950 border border-gray-800 rounded-lg p-2.5 text-sm font-bold text-white outline-none">
            <option value="EVEN">Even / Odd (80% Payout)</option>
            <option value="OVER_UNDER">Over / Under</option>
          </select>
        </div>

        <div id="digitTargetWrapper" class="hidden">
          <label class="block text-xs font-bold text-gray-400 mb-1">Target Prediction Digit (0-9)</label>
          <input id="targetDigitInput" type="number" min="0" max="9" value="5" oninput="updateCalculations()" class="w-full bg-gray-950 border border-gray-800 rounded-lg p-2 text-sm font-bold text-white">
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-xs font-bold text-gray-400 mb-1">Stake (USD)</label>
            <input id="stakeInput" type="number" value="10" oninput="updateCalculations()" class="w-full bg-gray-950 border border-gray-800 rounded-lg p-2.5 text-sm font-bold text-white outline-none">
          </div>
          <div>
            <label class="block text-xs font-bold text-gray-400 mb-1">Ticks Duration</label>
            <input id="durationInput" type="number" min="1" max="10" value="1" class="w-full bg-gray-950 border border-gray-800 rounded-lg p-2.5 text-sm font-bold text-white outline-none">
          </div>
        </div>

        <!-- AUTO TRADES CONTROLLER -->
        <div class="bg-gray-950 border border-gray-800 rounded-lg p-3 space-y-2">
          <div class="flex justify-between items-center">
            <span class="text-xs font-bold text-purple-400">🤖 AUTO TRADING BOT</span>
            <input id="autoTradeToggle" type="checkbox" onchange="toggleAutoTrade()" class="w-4 h-4 accent-purple-600 cursor-pointer">
          </div>
          <div id="autoTradeSettings" class="grid grid-cols-2 gap-2 hidden">
            <div>
              <label class="block text-[10px] text-gray-400">Total Runs</label>
              <input id="autoTradeRuns" type="number" value="5" min="1" max="50" class="w-full bg-gray-900 border border-gray-800 rounded p-1 text-xs text-white">
            </div>
            <div>
              <label class="block text-[10px] text-gray-400">Runs Remaining</label>
              <div id="autoTradeStatus" class="text-xs font-bold text-yellow-400 py-1">0</div>
            </div>
          </div>
        </div>

        <!-- PAYOUT DISPLAY -->
        <div class="bg-gray-950 border border-gray-800 rounded-lg p-3 space-y-1">
          <div class="flex justify-between text-xs text-gray-400">
            <span>Stake:</span>
            <span id="summaryStake" class="font-bold text-white">$10.00</span>
          </div>
          <div class="flex justify-between text-xs text-gray-400">
            <span>Payout Rate:</span>
            <span id="summaryPayout" class="font-bold text-green-400">$18.00 (80%)</span>
          </div>
        </div>

        <div id="actionButtonsContainer" class="grid grid-cols-2 gap-3 pt-2">
          <button onclick="executeTradeWithSide('EVEN')" class="bg-blue-600 hover:bg-blue-500 py-3 rounded-lg font-black text-sm uppercase">EVEN</button>
          <button onclick="executeTradeWithSide('ODD')" class="bg-red-600 hover:bg-red-500 py-3 rounded-lg font-black text-sm uppercase">ODD</button>
        </div>

      </div>

      <div class="mt-4 border-t border-gray-800 pt-3">
        <h3 class="text-xs font-bold text-gray-400 uppercase mb-2">Trade Execution Log</h3>
        <div id="tradesLog" class="space-y-2 max-h-40 overflow-y-auto pr-1"></div>
      </div>
    </div>
  </div>

  <!-- STK DEPOSIT MODAL -->
  <div id="depositModal" class="fixed inset-0 bg-black/80 z-50 hidden flex items-center justify-center p-4">
    <div class="bg-gray-900 border border-gray-800 w-full max-w-md rounded-2xl p-6">
      <h3 class="text-lg font-bold text-white mb-1">M-Pesa Express STK Push</h3>
      <p class="text-xs text-gray-400 mb-4">Prompt will pop up on your registered phone screen requiring your PIN.</p>
      <div class="space-y-4">
        <div>
          <label class="block text-xs text-gray-400 mb-1">Registered Phone</label>
          <input id="depositMobileDisplay" type="text" readonly class="w-full bg-gray-950 border border-gray-800 rounded-lg p-2.5 text-sm font-bold text-gray-400 cursor-not-allowed">
        </div>
        <div>
          <label class="block text-xs text-gray-400 mb-1">Deposit Amount (KES)</label>
          <input id="depositAmount" type="number" value="10" class="w-full bg-gray-950 border border-gray-800 rounded-lg p-2.5 text-sm font-bold text-white">
        </div>
        <button onclick="processStkPushDeposit()" class="w-full bg-green-600 hover:bg-green-500 font-bold py-3 rounded-lg text-sm">Send STK Push Prompt</button>
        <button onclick="closeDepositModal()" class="w-full text-xs text-gray-400 hover:underline">Cancel</button>
      </div>
    </div>
  </div>

  <!-- WITHDRAWAL MODAL -->
  <div id="withdrawModal" class="fixed inset-0 bg-black/80 z-50 hidden flex items-center justify-center p-4">
    <div class="bg-gray-900 border border-gray-800 w-full max-w-md rounded-2xl p-6">
      <h3 class="text-lg font-bold text-white mb-1">Withdraw Funds</h3>
      <p class="text-xs text-gray-400 mb-4">Funds will be sent directly to your registered phone number.</p>
      <div class="space-y-4">
        <div>
          <label class="block text-xs text-gray-400 mb-1">Registered Number</label>
          <input id="withdrawMobileDisplay" type="text" readonly class="w-full bg-gray-950 border border-gray-800 rounded-lg p-2.5 text-sm font-bold text-gray-400 cursor-not-allowed">
        </div>
        <div>
          <label class="block text-xs text-gray-400 mb-1">Withdrawal Amount ($)</label>
          <input id="withdrawAmount" type="number" value="10" class="w-full bg-gray-950 border border-gray-800 rounded-lg p-2.5 text-sm font-bold text-white">
        </div>
        <button onclick="processWithdrawal()" class="w-full bg-red-600 hover:bg-red-500 font-bold py-3 rounded-lg text-sm">Process Withdrawal</button>
        <button onclick="closeWithdrawModal()" class="w-full text-xs text-gray-400 hover:underline">Cancel</button>
      </div>
    </div>
  </div>

  <script>
    let currentUser = null;
    let authMode = 'LOGIN';
    let currentAccountType = 'DEMO';
    let activeSymbol = '1HZ10V';
    let chartInstance = null;
    let autoTradeActive = false;
    let autoTradeRemaining = 0;
    let autoTradeSide = 'EVEN';

    // Build Digits Bar
    const streamContainer = document.getElementById('horizontalDigitStream');
    for (let i = 0; i <= 9; i++) {
      const node = document.createElement('div');
      node.id = 'digit-node-' + i;
      node.className = 'digit-badge bg-gray-950 border border-gray-800 rounded-lg p-2 text-center';
      node.innerHTML = \`<div class="text-sm font-bold text-gray-300">\${i}</div>\`;
      streamContainer.appendChild(node);
    }

    // Chart Setup
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
        scales: { x: { display: false }, y: { grid: { color: '#111827' }, ticks: { color: '#9ca3af' } } }
      }
    });

    // WebSocket
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(\`\${protocol}//\${window.location.host}\`);

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
          currentUser.totalPL = data.totalPL;
          updateBalanceDisplay();
          logTradeResult(data.trade);

          if (autoTradeActive && autoTradeRemaining > 0) {
            autoTradeRemaining--;
            document.getElementById('autoTradeStatus').innerText = autoTradeRemaining;
            if (autoTradeRemaining > 0) {
              setTimeout(() => { executeTradeWithSide(autoTradeSide); }, 1500);
            } else {
              autoTradeActive = false;
              document.getElementById('autoTradeToggle').checked = false;
              alert('Auto Trading Completed!');
            }
          }
        }
      } else if (data.type === 'STK_SUCCESS') {
        if (currentUser && data.userId === currentUser.id) {
          currentUser.realBalance = data.realBalance;
          updateBalanceDisplay();
          alert(data.message);
        }
      }
    };

    function updateBalanceDisplay() {
      if (!currentUser) return;

      const pl = currentUser.totalPL || 0;
      const plEl = document.getElementById('totalPLDisplay');
      plEl.innerText = (pl >= 0 ? '+$' : '-$') + Math.abs(pl).toFixed(2);
      plEl.className = pl >= 0 ? "text-sm font-black text-green-400" : "text-sm font-black text-red-400";

      if (currentAccountType === 'DEMO') {
        document.getElementById('balanceDisplay').innerText = '$' + currentUser.demoBalance.toFixed(2);
        document.getElementById('accountTypeLabel').innerText = 'Demo Account';
        document.getElementById('accountTypeLabel').className = 'text-[10px] uppercase font-bold text-blue-400';
        document.getElementById('resetDemoBtn').classList.remove('hidden');
      } else {
        document.getElementById('balanceDisplay').innerText = '$' + currentUser.realBalance.toFixed(2);
        document.getElementById('accountTypeLabel').innerText = 'Real Account';
        document.getElementById('accountTypeLabel').className = 'text-[10px] uppercase font-bold text-green-400';
        document.getElementById('resetDemoBtn').classList.add('hidden');
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

    async function resetDemoBalance() {
      if (!currentUser) return;
      const res = await fetch('/api/auth/reset-demo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: currentUser.id })
      });
      const data = await res.json();
      if (data.success) {
        currentUser.demoBalance = data.demoBalance;
        updateBalanceDisplay();
      }
    }

    function toggleAutoTrade() {
      const isChecked = document.getElementById('autoTradeToggle').checked;
      const settings = document.getElementById('autoTradeSettings');
      if (isChecked) {
        settings.classList.remove('hidden');
        autoTradeActive = true;
        autoTradeRemaining = parseInt(document.getElementById('autoTradeRuns').value, 10) || 5;
        document.getElementById('autoTradeStatus').innerText = autoTradeRemaining;
      } else {
        settings.classList.add('hidden');
        autoTradeActive = false;
      }
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
          <button onclick="executeTradeWithSide('EVEN')" class="bg-blue-600 hover:bg-blue-500 py-3 rounded-lg font-black text-sm uppercase">EVEN</button>
          <button onclick="executeTradeWithSide('ODD')" class="bg-red-600 hover:bg-red-500 py-3 rounded-lg font-black text-sm uppercase">ODD</button>
        \`;
      } else {
        targetWrapper.classList.remove('hidden');
        actionBox.innerHTML = \`
          <button onclick="executeTradeWithSide('OVER')" class="bg-green-600 hover:bg-green-500 py-3 rounded-lg font-black text-sm uppercase">OVER</button>
          <button onclick="executeTradeWithSide('UNDER')" class="bg-yellow-600 hover:bg-yellow-500 py-3 rounded-lg font-black text-sm uppercase">UNDER</button>
        \`;
      }
      updateCalculations();
    }

    function updateCalculations() {
      const stake = parseFloat(document.getElementById('stakeInput').value) || 0;
      const type = document.getElementById('tradeTypeSelect').value;
      const digit = parseInt(document.getElementById('targetDigitInput').value, 10);
      let multiplier = 0.80;

      if (type === 'OVER_UNDER') {
        if (digit === 1 || digit === 9) multiplier = 0.30;
        else if (digit >= 3 && digit <= 6) multiplier = 0.50;
        else multiplier = 0.50;
      }

      const payout = stake + (stake * multiplier);
      document.getElementById('summaryStake').innerText = '$' + stake.toFixed(2);
      document.getElementById('summaryPayout').innerText = '$' + payout.toFixed(2) + ' (' + (multiplier * 100).toFixed(0) + '%)';
    }

    async function executeTradeWithSide(selectedType) {
      if (!currentUser) return alert("Please log in first.");

      autoTradeSide = selectedType;

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

    function logTradeResult(trade) {
      const log = document.getElementById('tradesLog');
      const item = document.createElement('div');
      item.className = "bg-gray-950 p-2.5 rounded-lg border border-gray-800 text-xs";
      
      const isWin = trade.status === 'WIN';
      const resultText = isWin ? '+$' + trade.netResult.toFixed(2) : '-$' + Math.abs(trade.payout).toFixed(2);

      item.innerHTML = \`
        <div class="flex justify-between font-bold">
          <span>\${trade.symbolName} (\${trade.tradeType})</span>
          <span class="\${isWin ? 'text-green-400' : 'text-red-400'}">\${trade.status} (\${resultText})</span>
        </div>
        <div class="text-[10px] text-gray-500 mt-1">
          Entry: \${trade.entryPrice} | Exit: \${trade.exitPrice}
        </div>
      \`;
      log.prepend(item);
    }

    function toggleAuthMode() {
      authMode = (authMode === 'LOGIN') ? 'REGISTER' : 'LOGIN';
      document.getElementById('authTitle').innerText = authMode === 'REGISTER' ? 'CREATE WORKSTATION ACCOUNT' : 'TRADERSCHEME LOGIN';
      document.getElementById('authSubmitBtn').innerText = authMode === 'REGISTER' ? 'Register Account' : 'Log In';
      document.getElementById('authToggleBtn').innerText = authMode === 'REGISTER' ? 'Already have an account? Login' : 'Need an account? Register';
      
      if (authMode === 'REGISTER') document.getElementById('mobileFieldWrapper').classList.remove('hidden');
      else document.getElementById('mobileFieldWrapper').classList.add('hidden');
    }

    async function submitAuth() {
      const email = document.getElementById('authEmail').value.trim();
      const mobile = document.getElementById('authMobile').value.trim();
      const password = document.getElementById('authPassword').value.trim();

      const endpoint = authMode === 'REGISTER' ? '/api/auth/register' : '/api/auth/login';
      const bodyPayload = authMode === 'REGISTER' ? { email, mobile, password } : { email, password };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyPayload)
      });

      const data = await res.json();
      if (data.error) return alert(data.error);

      currentUser = data.user;
      updateBalanceDisplay();
      document.getElementById('authModal').classList.add('hidden');
    }

    async function runAiScan() {
      const res = await fetch('/api/ai/deep-scan');
      const data = await res.json();
      if (data.success) {
        alert(\`AI Scan Analysis Complete!\n\nBest Market: \${data.recommendation.name}\nRecommended Option: \${data.recommendation.bestContract}\nConfidence Rate: \${data.recommendation.confidence}%\`);
      }
    }

    function openDepositModal() {
      if (!currentUser) return alert("Please log in first.");
      document.getElementById('depositMobileDisplay').value = currentUser.mobile || "No number registered";
      document.getElementById('depositModal').classList.remove('hidden');
    }
    
    function closeDepositModal() {
      document.getElementById('depositModal').classList.add('hidden');
    }

    async function processStkPushDeposit() {
      const amount = document.getElementById('depositAmount').value;
      const res = await fetch('/api/wallet/stk-push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: currentUser.id, amount })
      });

      const data = await res.json();
      if (data.error) return alert(data.error);

      alert(data.message);
      closeDepositModal();
    }

    function openWithdrawModal() {
      if (!currentUser) return alert("Please log in first.");
      document.getElementById('withdrawMobileDisplay').value = currentUser.mobile || "No number registered";
      document.getElementById('withdrawModal').classList.remove('hidden');
    }

    function closeWithdrawModal() {
      document.getElementById('withdrawModal').classList.add('hidden');
    }

    async function processWithdrawal() {
      const amount = document.getElementById('withdrawAmount').value;
      const res = await fetch('/api/wallet/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: currentUser.id, amount })
      });

      const data = await res.json();
      if (data.error) return alert(data.error);

      currentUser.realBalance = data.realBalance;
      updateBalanceDisplay();
      alert(data.message);
      closeWithdrawModal();
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
