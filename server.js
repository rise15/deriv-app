const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());

// -------------------------------------------------------------
// In-Memory Database Storage
// -------------------------------------------------------------
const users = []; // Stores { id, email, password, balance, resetToken, resetExpiry }
const trades = [];
const transactions = [];

// Volatility Markets Definition
const markets = {
  'R_10':  { name: 'Volatility 10 Index',  price: 1204.32, vol: 0.10, history: [] },
  'R_25':  { name: 'Volatility 25 Index',  price: 2541.87, vol: 0.25, history: [] },
  'R_50':  { name: 'Volatility 50 Index',  price: 4890.15, vol: 0.50, history: [] },
  'R_75':  { name: 'Volatility 75 Index',  price: 6512.64, vol: 0.75, history: [] },
  'R_100': { name: 'Volatility 100 Index', price: 9821.43, vol: 1.00, history: [] },
  '1HZ10V':{ name: 'Volatility 10 (1s) Index', price: 1510.90, vol: 0.15, history: [] }
};

// Real-Time Synthetic Market Data Generator Engine
setInterval(() => {
  Object.keys(markets).forEach(symbol => {
    const m = markets[symbol];
    const delta = (Math.random() - 0.498) * m.vol * 8;
    m.price = parseFloat((m.price + delta).toFixed(2));
    
    // Extract last digit for digit-based trading ring
    const priceStr = m.price.toFixed(2);
    const lastDigit = parseInt(priceStr.slice(-1), 10);

    m.history.push({ price: m.price, digit: lastDigit, timestamp: Date.now() });
    if (m.history.length > 100) m.history.shift();
  });

  broadcastMarketTicks();
}, 1000);

function broadcastMarketTicks() {
  const tickPayload = JSON.stringify({
    type: 'TICK_UPDATE',
    markets: markets
  });

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(tickPayload);
    }
  });
}

// -------------------------------------------------------------
// 1. AUTHENTICATION & RECOVERY ENDPOINTS
// -------------------------------------------------------------
app.post('/api/auth/register', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }

  const existingUser = users.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (existingUser) {
    return res.status(400).json({ error: "Email already registered. Please click 'Log In'." });
  }

  const newUser = { id: 'USR-' + Date.now(), email, password, balance: 1000.00 };
  users.push(newUser);
  res.json({ success: true, user: { id: newUser.id, email: newUser.email, balance: newUser.balance } });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }

  const user = users.find(u => u.email.toLowerCase() === email.toLowerCase() && u.password === password);
  if (!user) {
    return res.status(401).json({ error: "Invalid credentials. Incorrect email or password." });
  }
  res.json({ success: true, user: { id: user.id, email: user.email, balance: user.balance } });
});

app.post('/api/auth/recover-request', (req, res) => {
  const { email } = req.body;
  const user = users.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (!user) {
    return res.status(404).json({ error: "Email account not found." });
  }
  
  const token = crypto.randomBytes(20).toString('hex');
  user.resetToken = token;
  user.resetExpiry = Date.now() + 3600000; // 1 hour token validity

  res.json({ success: true, message: "Recovery token dispatched.", resetToken: token });
});

app.post('/api/auth/reset-password', (req, res) => {
  const { token, newPassword } = req.body;
  const user = users.find(u => u.resetToken === token && u.resetExpiry > Date.now());
  if (!user) {
    return res.status(400).json({ error: "Invalid or expired recovery token." });
  }
  
  user.password = newPassword;
  user.resetToken = null;
  user.resetExpiry = null;
  res.json({ success: true, message: "Password reset successful. You can now log in." });
});

// -------------------------------------------------------------
// 2. AI DEEP SCAN MARKET ANALYZER
// -------------------------------------------------------------
app.get('/api/ai/deep-scan', (req, res) => {
  let bestMarket = null;
  let highestScore = -1;
  const analysisReport = {};

  Object.keys(markets).forEach(symbol => {
    const history = markets[symbol].history;
    if (history.length < 10) {
      analysisReport[symbol] = { score: 50, signal: 'NEUTRAL' };
      return;
    }

    const prices = history.map(h => h.price);
    const first = prices[0];
    const last = prices[prices.length - 1];
    const momentum = ((last - first) / first) * 100;
    
    // Evaluate Digit Distributions
    const digits = history.map(h => h.digit);
    const digitCounts = Array(10).fill(0);
    digits.forEach(d => digitCounts[d]++);
    const maxDigitFreq = Math.max(...digitCounts);

    const score = Math.min(99, Math.floor(Math.abs(momentum) * 400 + maxDigitFreq * 8 + Math.random() * 10));

    analysisReport[symbol] = {
      name: markets[symbol].name,
      score,
      momentum: momentum > 0 ? 'BULLISH' : 'BEARISH',
      dominantDigit: digitCounts.indexOf(maxDigitFreq),
      recommendation: score > 75 ? 'HIGH WIN PROBABILITY' : 'MODERATE RISK'
    };

    if (score > highestScore) {
      highestScore = score;
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
// 3. TRADING ENGINE (MANUAL & AUTOMATED)
// -------------------------------------------------------------
app.post('/api/trade/execute', (req, res) => {
  const { userId, symbol, tradeType, stake, durationSeconds, targetDigit, mode } = req.body;
  const user = users.find(u => u.id === userId);
  
  if (!user) return res.status(404).json({ error: "User profile not found. Please login." });
  if (user.balance < stake) return res.status(400).json({ error: "Insufficient wallet balance." });

  const market = markets[symbol];
  if (!market) return res.status(400).json({ error: "Invalid market symbol selected." });

  user.balance -= stake;

  const entryPrice = market.price;
  const entryDigit = parseInt(entryPrice.toFixed(2).slice(-1), 10);

  const trade = {
    id: 'TRD-' + Math.floor(Math.random() * 1000000),
    userId,
    symbol,
    symbolName: market.name,
    tradeType, // RISE, FALL, MATCH_DIGIT, DIFF_DIGIT
    stake: parseFloat(stake),
    entryPrice,
    entryDigit,
    targetDigit: targetDigit !== undefined ? parseInt(targetDigit, 10) : null,
    mode: mode || 'MANUAL',
    status: 'OPEN',
    createdAt: Date.now()
  };

  trades.push(trade);

  // Settle trade after duration
  setTimeout(() => {
    const exitPrice = markets[symbol].price;
    const exitDigit = parseInt(exitPrice.toFixed(2).slice(-1), 10);
    let win = false;
    let payoutMultiplier = 0.85;

    if (tradeType === 'RISE') win = exitPrice > entryPrice;
    else if (tradeType === 'FALL') win = exitPrice < entryPrice;
    else if (tradeType === 'MATCH_DIGIT') {
      win = exitDigit === trade.targetDigit;
      payoutMultiplier = 8.0;
    } else if (tradeType === 'DIFF_DIGIT') {
      win = exitDigit !== trade.targetDigit;
      payoutMultiplier = 0.10;
    }

    trade.exitPrice = exitPrice;
    trade.exitDigit = exitDigit;

    if (win) {
      const returnAmount = trade.stake + (trade.stake * payoutMultiplier);
      user.balance += returnAmount;
      trade.status = 'WIN';
      trade.payout = returnAmount;
    } else {
      trade.status = 'LOSS';
      trade.payout = 0;
    }

    // Broadcast result to user over WebSocket
    const updatePayload = JSON.stringify({ type: 'TRADE_SETTLED', trade, balance: user.balance });
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) client.send(updatePayload);
    });

  }, (durationSeconds || 5) * 1000);

  res.json({ success: true, trade, currentBalance: user.balance });
});

// -------------------------------------------------------------
// 4. DEPOSITS & WITHDRAWALS
// -------------------------------------------------------------
app.post('/api/wallet/deposit', (req, res) => {
  const { userId, amount, paymentMethod } = req.body;
  const user = users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: "User profile not found." });

  const numAmount = parseFloat(amount);
  if (isNaN(numAmount) || numAmount <= 0) return res.status(400).json({ error: "Invalid deposit amount." });

  user.balance += numAmount;

  const txn = {
    id: 'TXN-DEP-' + Date.now(),
    userId,
    type: 'DEPOSIT',
    amount: numAmount,
    method: paymentMethod || 'Instant Card/Crypto',
    status: 'COMPLETED',
    timestamp: Date.now()
  };
  transactions.push(txn);

  res.json({ success: true, message: "Deposit processed instantly.", balance: user.balance, transaction: txn });
});

app.post('/api/wallet/withdraw', (req, res) => {
  const { userId, amount, accountDetails } = req.body;
  const user = users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: "User profile not found." });

  const numAmount = parseFloat(amount);
  if (user.balance < numAmount) return res.status(400).json({ error: "Insufficient wallet balance." });

  user.balance -= numAmount;

  const txn = {
    id: 'TXN-WTH-' + Date.now(),
    userId,
    type: 'WITHDRAWAL',
    amount: numAmount,
    accountDetails,
    status: 'COMPLETED',
    timestamp: Date.now()
  };
  transactions.push(txn);

  res.json({ success: true, message: "Withdrawal executed successfully.", balance: user.balance, transaction: txn });
});

// -------------------------------------------------------------
// FRONTEND INTERFACE DASHBOARD
// -------------------------------------------------------------
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Deriv Trading Platform Clone</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://unpkg.com/lightweight-charts/dist/lightweight-charts.standalone.production.js"></script>
  <style>
    .digit-circle {
      position: relative;
      width: 200px;
      height: 200px;
      border-radius: 50%;
      border: 4px solid #1f2937;
      margin: 0 auto;
    }
    .digit-node {
      position: absolute;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background-color: #111827;
      border: 1px solid #374151;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: bold;
      font-size: 12px;
      color: #9ca3af;
      transition: all 0.2s ease;
    }
    .digit-node.active {
      background-color: #2563eb;
      color: #ffffff;
      border-color: #60a5fa;
      transform: scale(1.3);
      box-shadow: 0 0 12px rgba(37, 99, 235, 0.8);
    }
  </style>
</head>
<body class="bg-gray-950 text-white font-sans overflow-x-hidden">

  <!-- AUTHENTICATION OVERLAY MODAL -->
  <div id="authModal" class="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
    <div class="bg-gray-900 border border-gray-800 w-full max-w-md rounded-xl p-6 shadow-2xl">
      <h2 id="authTitle" class="text-2xl font-black text-red-500 mb-6 text-center">DERIV LOGIN</h2>
      
      <!-- Form Input Controls -->
      <div id="mainAuthForm" class="space-y-4">
        <div>
          <label class="block text-xs text-gray-400 mb-1">Email Address</label>
          <input id="authEmail" type="email" placeholder="user@example.com" class="w-full bg-gray-950 border border-gray-800 rounded p-2 text-sm focus:outline-none focus:border-red-500">
        </div>
        <div>
          <label class="block text-xs text-gray-400 mb-1">Password</label>
          <input id="authPassword" type="password" placeholder="••••••••" class="w-full bg-gray-950 border border-gray-800 rounded p-2 text-sm focus:outline-none focus:border-red-500">
        </div>
        <button id="authSubmitBtn" onclick="submitAuth()" class="w-full bg-red-600 hover:bg-red-500 py-2.5 rounded font-bold text-sm">Log In</button>
        
        <div class="flex justify-between items-center text-xs text-gray-400 mt-4">
          <button onclick="toggleAuthMode()" id="authToggleBtn" class="hover:underline text-blue-400">Need an account? Register</button>
          <button onclick="showRecoveryForm()" class="hover:underline text-gray-400">Forgot password?</button>
        </div>
      </div>

      <!-- Password Recovery Form -->
      <div id="recoveryForm" class="space-y-4 hidden">
        <p class="text-xs text-gray-400">Enter your account email to generate a recovery token.</p>
        <div>
          <label class="block text-xs text-gray-400 mb-1">Email Address</label>
          <input id="recoverEmail" type="email" placeholder="user@example.com" class="w-full bg-gray-950 border border-gray-800 rounded p-2 text-sm">
        </div>
        <button onclick="requestPasswordRecovery()" class="w-full bg-blue-600 hover:bg-blue-500 py-2.5 rounded font-bold text-sm">Send Recovery Request</button>
        
        <div id="resetFields" class="hidden space-y-3 pt-3 border-t border-gray-800">
          <div>
            <label class="block text-xs text-gray-400 mb-1">Recovery Token</label>
            <input id="resetTokenInput" type="text" placeholder="Paste Token" class="w-full bg-gray-950 border border-gray-800 rounded p-2 text-sm">
          </div>
          <div>
            <label class="block text-xs text-gray-400 mb-1">New Password</label>
            <input id="resetNewPassword" type="password" placeholder="New Password" class="w-full bg-gray-950 border border-gray-800 rounded p-2 text-sm">
          </div>
          <button onclick="executePasswordReset()" class="w-full bg-green-600 hover:bg-green-500 py-2.5 rounded font-bold text-sm">Reset Password</button>
        </div>

        <button onclick="hideRecoveryForm()" class="w-full text-xs text-gray-400 hover:underline mt-2">Back to Login</button>
      </div>
    </div>
  </div>

  <!-- PLATFORM HEADER NAVBAR -->
  <header class="bg-gray-900 border-b border-gray-800 px-6 py-3 flex justify-between items-center">
    <div class="flex items-center gap-6">
      <h1 class="text-xl font-black text-red-500 tracking-wider">DERIV <span class="text-white text-xs font-normal">SYNTHETICS ENGINE</span></h1>
      <select id="marketSelect" onchange="changeMarket()" class="bg-gray-800 border border-gray-700 font-bold py-1.5 px-3 rounded text-sm text-yellow-400">
        <option value="R_10">Volatility 10 Index</option>
        <option value="R_25">Volatility 25 Index</option>
        <option value="R_50">Volatility 50 Index</option>
        <option value="R_75" selected>Volatility 75 Index</option>
        <option value="R_100">Volatility 100 Index</option>
        <option value="1HZ10V">Volatility 10 (1s) Index</option>
      </select>
      <button onclick="runAiScan()" class="bg-purple-900/60 hover:bg-purple-800 border border-purple-600 text-purple-300 font-bold text-xs px-3 py-1.5 rounded flex items-center gap-1.5">
        ⚡ AI Deep Scan
      </button>
    </div>

    <div class="flex items-center gap-6">
      <div>
        <span class="text-xs text-gray-400">Account: </span>
        <span id="userEmailDisplay" class="text-xs font-bold text-gray-300">Not Logged In</span>
      </div>
      <div>
        <span class="text-xs text-gray-400">Balance: </span>
        <span id="balanceDisplay" class="text-lg font-black text-green-400">$0.00</span>
      </div>
      <div class="flex gap-2">
        <button onclick="openWalletModal('DEPOSIT')" class="bg-green-600 hover:bg-green-500 font-bold text-xs px-3 py-1.5 rounded">+ Deposit</button>
        <button onclick="openWalletModal('WITHDRAW')" class="bg-gray-800 hover:bg-gray-700 font-bold text-xs px-3 py-1.5 rounded border border-gray-700">- Withdraw</button>
      </div>
    </div>
  </header>

  <!-- TRADING DASHBOARD WORKSPACE -->
  <div class="grid grid-cols-12 h-[calc(100vh-57px)]">
    
    <!-- LEFT PANEL: CHART AND DIGIT CURSOR -->
    <div class="col-span-8 p-4 flex flex-col justify-between border-r border-gray-800">
      <div class="flex justify-between items-center mb-2">
        <div>
          <h2 id="activeMarketTitle" class="text-md font-bold text-gray-300">Volatility 75 Index</h2>
          <p id="aiSignalBadge" class="text-[10px] text-purple-400">AI Status: Idle</p>
        </div>
        <div class="text-3xl font-black text-green-400" id="livePriceDisplay">0000.00</div>
      </div>

      <!-- Live Interactive Line Chart -->
      <div id="chartContainer" class="w-full flex-1 bg-gray-900 rounded-lg border border-gray-800 my-2"></div>

      <!-- Circular Last-Digit Cursor Indicator -->
      <div class="bg-gray-900 border border-gray-800 rounded-lg p-4 flex items-center justify-around">
        <div class="text-center">
          <p class="text-xs text-gray-400 uppercase font-bold mb-1">Tick Digit Cursor</p>
          <p class="text-2xl font-black text-blue-400" id="currentDigitDisplay">0</p>
        </div>
        
        <!-- Digit Ring Component -->
        <div class="digit-circle" id="digitCircleRing"></div>
      </div>
    </div>

    <!-- RIGHT PANEL: CONTROL PANEL & BOT ENGINE -->
    <div class="col-span-4 bg-gray-900 p-4 flex flex-col justify-between">
      <div>
        <!-- Mode Navigation -->
        <div class="flex border-b border-gray-800 pb-3 mb-4">
          <button onclick="setTradeMode('MANUAL')" id="manualTabBtn" class="flex-1 py-1.5 font-bold text-xs text-center border-b-2 border-red-500 text-white">MANUAL TRADING</button>
          <button onclick="setTradeMode('AUTO')" id="autoTabBtn" class="flex-1 py-1.5 font-bold text-xs text-center border-b-2 border-transparent text-gray-500">AUTO-BOT TRADER</button>
        </div>

        <!-- Trade Configuration -->
        <div class="space-y-4">
          <div>
            <label class="block text-xs text-gray-400 mb-1">Contract Type</label>
            <select id="tradeTypeSelect" onchange="toggleDigitControls()" class="w-full bg-gray-950 border border-gray-800 rounded p-2 text-sm font-bold text-gray-200">
              <option value="RISE">Rise (Call)</option>
              <option value="FALL">Fall (Put)</option>
              <option value="MATCH_DIGIT">Matches Last Digit</option>
              <option value="DIFF_DIGIT">Differs Last Digit</option>
            </select>
          </div>

          <div id="digitTargetWrapper" class="hidden">
            <label class="block text-xs text-gray-400 mb-1">Target Prediction Digit (0-9)</label>
            <input id="targetDigitInput" type="number" min="0" max="9" value="5" class="w-full bg-gray-950 border border-gray-800 rounded p-2 text-sm font-bold">
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-xs text-gray-400 mb-1">Stake ($)</label>
              <input id="stakeInput" type="number" value="10" class="w-full bg-gray-950 border border-gray-800 rounded p-2 text-sm font-bold">
            </div>
            <div>
              <label class="block text-xs text-gray-400 mb-1">Duration (Seconds)</label>
              <input id="durationInput" type="number" value="5" class="w-full bg-gray-950 border border-gray-800 rounded p-2 text-sm font-bold">
            </div>
          </div>

          <!-- Trade Action Trigger Buttons -->
          <div id="manualExecutionBox" class="pt-2">
            <button onclick="executeTrade()" class="w-full bg-red-600 hover:bg-red-500 py-3 rounded font-black text-sm uppercase tracking-wider">Purchase Trade</button>
          </div>

          <div id="autoExecutionBox" class="pt-2 hidden">
            <button id="autoBotBtn" onclick="toggleAutoBot()" class="w-full bg-purple-600 hover:bg-purple-500 py-3 rounded font-black text-sm uppercase tracking-wider">Start Auto-Trader Bot</button>
          </div>
        </div>
      </div>

      <!-- Trade Log Stream -->
      <div class="mt-4 border-t border-gray-800 pt-3 flex-1 flex flex-col justify-end">
        <h3 class="text-xs font-bold text-gray-400 uppercase mb-2">Trade History Log</h3>
        <div id="tradesLog" class="space-y-2 max-h-48 overflow-y-auto"></div>
      </div>
    </div>
  </div>

  <!-- WALLET MODAL -->
  <div id="walletModal" class="fixed inset-0 bg-black/80 z-50 hidden flex items-center justify-center p-4">
    <div class="bg-gray-900 border border-gray-800 w-full max-w-md rounded-xl p-6">
      <h3 id="walletModalTitle" class="text-lg font-bold mb-4">Deposit Funds</h3>
      <div class="space-y-4">
        <div>
          <label class="block text-xs text-gray-400 mb-1">Amount ($)</label>
          <input id="walletAmountInput" type="number" value="100" class="w-full bg-gray-950 border border-gray-800 rounded p-2 text-sm">
        </div>
        <button onclick="submitWalletAction()" class="w-full bg-green-600 hover:bg-green-500 py-2.5 rounded font-bold text-sm">Confirm Transaction</button>
        <button onclick="closeWalletModal()" class="w-full text-xs text-gray-400 hover:underline">Cancel</button>
      </div>
    </div>
  </div>

  <script>
    let currentUser = null;
    let authMode = 'LOGIN';
    let activeSymbol = 'R_75';
    let activeTradeMode = 'MANUAL';
    let autoBotActive = false;
    let autoBotInterval = null;
    let activeWalletAction = 'DEPOSIT';

    // Construct Circular Digit Nodes
    const ring = document.getElementById('digitCircleRing');
    const radius = 80;
    for(let i = 0; i < 10; i++) {
      const angle = (i * 36 - 90) * (Math.PI / 180);
      const x = 100 + radius * Math.cos(angle) - 16;
      const y = 100 + radius * Math.sin(angle) - 16;
      const node = document.createElement('div');
      node.className = 'digit-node';
      node.id = 'digit-node-' + i;
      node.innerText = i;
      node.style.left = x + 'px';
      node.style.top = y + 'px';
      ring.appendChild(node);
    }

    // Chart Setup
    const chartContainer = document.getElementById('chartContainer');
    const chart = LightweightCharts.createChart(chartContainer, {
      layout: { backgroundColor: '#030712', textColor: '#9ca3af' },
      grid: { vertLines: { color: '#111827' }, horzLines: { color: '#111827' } },
      timeScale: { timeVisible: true, secondsVisible: true }
    });
    let lineSeries = chart.addLineSeries({ color: '#2563eb', lineWidth: 2 });

    window.addEventListener('resize', () => {
      chart.applyOptions({ width: chartContainer.clientWidth, height: chartContainer.clientHeight });
    });
    chart.applyOptions({ width: chartContainer.clientWidth, height: chartContainer.clientHeight });

    // WebSocket Engine Client
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(\`\${protocol}//\${window.location.host}\`);

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      
      if (data.type === 'TICK_UPDATE') {
        const m = data.markets[activeSymbol];
        if (m) {
          document.getElementById('livePriceDisplay').innerText = m.price.toFixed(2);
          lineSeries.update({ time: Math.floor(Date.now() / 1000), value: m.price });

          // Active Digit Cursor Ring Update
          const lastDigit = parseInt(m.price.toFixed(2).slice(-1), 10);
          document.getElementById('currentDigitDisplay').innerText = lastDigit;
          
          document.querySelectorAll('.digit-node').forEach(node => node.classList.remove('active'));
          const activeNode = document.getElementById('digit-node-' + lastDigit);
          if (activeNode) activeNode.classList.add('active');
        }
      } else if (data.type === 'TRADE_SETTLED') {
        if (currentUser && data.trade.userId === currentUser.id) {
          currentUser.balance = data.balance;
          document.getElementById('balanceDisplay').innerText = '$' + currentUser.balance.toFixed(2);
          logTradeResult(data.trade);
        }
      }
    };

    // FIXED Authentication Switcher Logic
    function toggleAuthMode() {
      authMode = (authMode === 'LOGIN') ? 'REGISTER' : 'LOGIN';
      
      const title = document.getElementById('authTitle');
      const submitBtn = document.getElementById('authSubmitBtn');
      const toggleBtn = document.getElementById('authToggleBtn');

      if (authMode === 'REGISTER') {
        title.innerText = 'CREATE DERIV ACCOUNT';
        submitBtn.innerText = 'Register Account';
        toggleBtn.innerText = 'Already have an account? Login';
      } else {
        title.innerText = 'DERIV LOGIN';
        submitBtn.innerText = 'Log In';
        toggleBtn.innerText = 'Need an account? Register';
      }
    }

    async function submitAuth() {
      const email = document.getElementById('authEmail').value.trim();
      const password = document.getElementById('authPassword').value.trim();

      if (!email || !password) {
        return alert("Please enter both an email address and a password.");
      }

      // Explicit Endpoint Routing Fix
      const endpoint = (authMode === 'REGISTER') ? '/api/auth/register' : '/api/auth/login';

      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password })
        });

        const data = await res.json();
        if (data.error) return alert(data.error);

        currentUser = data.user;
        document.getElementById('userEmailDisplay').innerText = currentUser.email;
        document.getElementById('balanceDisplay').innerText = '$' + currentUser.balance.toFixed(2);
        document.getElementById('authModal').classList.add('hidden');
        
        alert(authMode === 'REGISTER' ? "Account created successfully! $1,000 demo balance added." : "Welcome back!");
      } catch (err) {
        alert("Connection error. Please try again.");
      }
    }

    function showRecoveryForm() {
      document.getElementById('mainAuthForm').classList.add('hidden');
      document.getElementById('recoveryForm').classList.remove('hidden');
    }

    function hideRecoveryForm() {
      document.getElementById('recoveryForm').classList.add('hidden');
      document.getElementById('mainAuthForm').classList.remove('hidden');
    }

    async function requestPasswordRecovery() {
      const email = document.getElementById('recoverEmail').value;
      const res = await fetch('/api/auth/recover-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      const data = await res.json();
      if (data.error) return alert(data.error);

      alert("Recovery token generated: " + data.resetToken);
      document.getElementById('resetFields').classList.remove('hidden');
    }

    async function executePasswordReset() {
      const token = document.getElementById('resetTokenInput').value;
      const newPassword = document.getElementById('resetNewPassword').value;

      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, newPassword })
      });

      const data = await res.json();
      if (data.error) return alert(data.error);

      alert(data.message);
      hideRecoveryForm();
    }

    // AI Deep Scanner Handler
    async function runAiScan() {
      const res = await fetch('/api/ai/deep-scan');
      const data = await res.json();
      if (data.success) {
        const best = data.bestMarket;
        document.getElementById('aiSignalBadge').innerText = \`AI Recommendation: \${best.name} (\${best.score}% Score - \${best.momentum})\`;
        alert(\`AI Deep Scan Complete!\nBest Market: \${best.name}\nScore: \${best.score}%\nMomentum: \${best.momentum}\nRecommendation: \${best.recommendation}\`);
      }
    }

    // Market and Contract Handlers
    function changeMarket() {
      activeSymbol = document.getElementById('marketSelect').value;
      const title = document.getElementById('marketSelect').options[document.getElementById('marketSelect').selectedIndex].text;
      document.getElementById('activeMarketTitle').innerText = title;
      chart.removeSeries(lineSeries);
      lineSeries = chart.addLineSeries({ color: '#2563eb', lineWidth: 2 });
    }

    function toggleDigitControls() {
      const type = document.getElementById('tradeTypeSelect').value;
      const wrapper = document.getElementById('digitTargetWrapper');
      if (type === 'MATCH_DIGIT' || type === 'DIFF_DIGIT') wrapper.classList.remove('hidden');
      else wrapper.classList.add('hidden');
    }

    function setTradeMode(mode) {
      activeTradeMode = mode;
      if (mode === 'MANUAL') {
        document.getElementById('manualTabBtn').className = 'flex-1 py-1.5 font-bold text-xs text-center border-b-2 border-red-500 text-white';
        document.getElementById('autoTabBtn').className = 'flex-1 py-1.5 font-bold text-xs text-center border-b-2 border-transparent text-gray-500';
        document.getElementById('manualExecutionBox').classList.remove('hidden');
        document.getElementById('autoExecutionBox').classList.add('hidden');
      } else {
        document.getElementById('autoTabBtn').className = 'flex-1 py-1.5 font-bold text-xs text-center border-b-2 border-purple-500 text-white';
        document.getElementById('manualTabBtn').className = 'flex-1 py-1.5 font-bold text-xs text-center border-b-2 border-transparent text-gray-500';
        document.getElementById('autoExecutionBox').classList.remove('hidden');
        document.getElementById('manualExecutionBox').classList.add('hidden');
      }
    }

    async function executeTrade() {
      if (!currentUser) return alert("Please create an account or log in first.");

      const payload = {
        userId: currentUser.id,
        symbol: activeSymbol,
        tradeType: document.getElementById('tradeTypeSelect').value,
        stake: parseFloat(document.getElementById('stakeInput').value),
        durationSeconds: parseInt(document.getElementById('durationInput').value, 10),
        targetDigit: parseInt(document.getElementById('targetDigitInput').value, 10),
        mode: activeTradeMode
      };

      const res = await fetch('/api/trade/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      if (data.error) return alert(data.error);

      currentUser.balance = data.currentBalance;
      document.getElementById('balanceDisplay').innerText = '$' + currentUser.balance.toFixed(2);
    }

    function toggleAutoBot() {
      autoBotActive = !autoBotActive;
      const btn = document.getElementById('autoBotBtn');
      if (autoBotActive) {
        btn.innerText = "Stop Auto-Trader Bot";
        btn.className = "w-full bg-red-600 hover:bg-red-500 py-3 rounded font-black text-sm uppercase tracking-wider";
        autoBotInterval = setInterval(() => { executeTrade(); }, 6000);
      } else {
        btn.innerText = "Start Auto-Trader Bot";
        btn.className = "w-full bg-purple-600 hover:bg-purple-500 py-3 rounded font-black text-sm uppercase tracking-wider";
        clearInterval(autoBotInterval);
      }
    }

    function logTradeResult(trade) {
      const log = document.getElementById('tradesLog');
      const item = document.createElement('div');
      item.className = "bg-gray-950 p-2.5 rounded border border-gray-800 text-xs";
      item.innerHTML = \`
        <div class="flex justify-between font-bold">
          <span>\${trade.symbolName} (\${trade.tradeType})</span>
          <span class="\${trade.status === 'WIN' ? 'text-green-400' : 'text-red-400'}">\${trade.status} (\$\${trade.payout.toFixed(2)})</span>
        </div>
        <div class="text-[10px] text-gray-500 mt-1">
          Entry: \${trade.entryPrice} | Exit: \${trade.exitPrice}
        </div>
      \`;
      log.prepend(item);
    }

    // Wallet Action Handlers
    function openWalletModal(action) {
      activeWalletAction = action;
      document.getElementById('walletModalTitle').innerText = action === 'DEPOSIT' ? 'Deposit Funds' : 'Withdraw Funds';
      document.getElementById('walletModal').classList.remove('hidden');
    }

    function closeWalletModal() {
      document.getElementById('walletModal').classList.add('hidden');
    }

    async function submitWalletAction() {
      if (!currentUser) return alert("Please log in first.");
      const amount = document.getElementById('walletAmountInput').value;
      const endpoint = activeWalletAction === 'DEPOSIT' ? '/api/wallet/deposit' : '/api/wallet/withdraw';

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: currentUser.id, amount })
      });

      const data = await res.json();
      if (data.error) return alert(data.error);

      currentUser.balance = data.balance;
      document.getElementById('balanceDisplay').innerText = '$' + currentUser.balance.toFixed(2);
      alert(data.message);
      closeWalletModal();
    }
  </script>
</body>
</html>
  `);
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Deriv Engine live on port ${PORT}`);
});
