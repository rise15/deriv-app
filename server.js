const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());

// -------------------------------------------------------------
// In-Memory Database
// -------------------------------------------------------------
const users = []; // Stores { id, email, password, demoBalance, realBalance, resetToken, resetExpiry }
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
// AUTHENTICATION & RECOVERY
// -------------------------------------------------------------
app.post('/api/auth/register', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password are required." });

  const existingUser = users.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (existingUser) return res.status(400).json({ error: "Email already registered." });

  const newUser = { id: 'USR-' + Date.now(), email, password, demoBalance: 10000.00, realBalance: 0.00 };
  users.push(newUser);
  res.json({ success: true, user: { id: newUser.id, email: newUser.email, demoBalance: newUser.demoBalance, realBalance: newUser.realBalance } });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = users.find(u => u.email.toLowerCase() === email.toLowerCase() && u.password === password);
  if (!user) return res.status(401).json({ error: "Invalid credentials." });
  res.json({ success: true, user: { id: user.id, email: user.email, demoBalance: user.demoBalance, realBalance: user.realBalance } });
});

// -------------------------------------------------------------
// AI SCANNER
// -------------------------------------------------------------
app.get('/api/ai/deep-scan', (req, res) => {
  let bestMarket = null;
  let highestScore = -1;
  const analysisReport = {};

  Object.keys(markets).forEach(symbol => {
    const history = markets[symbol].history;
    const prices = history.map(h => h.price);
    const momentum = ((prices[prices.length - 1] - prices[0]) / prices[0]) * 100;
    const score = Math.floor(Math.abs(momentum) * 500 + Math.random() * 40 + 50);

    analysisReport[symbol] = {
      name: markets[symbol].name,
      score: Math.min(score, 99),
      momentum: momentum >= 0 ? 'BULLISH' : 'BEARISH'
    };

    if (score > highestScore) {
      highestScore = score;
      bestMarket = symbol;
    }
  });

  res.json({ success: true, bestMarket: { symbol: bestMarket, ...analysisReport[bestMarket] }, fullReport: analysisReport });
});

// -------------------------------------------------------------
// TRADING ENGINE
// -------------------------------------------------------------
app.post('/api/trade/execute', (req, res) => {
  const { userId, accountType, symbol, tradeType, stake, durationSeconds, targetDigit } = req.body;
  const user = users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: "User not found." });

  const numStake = parseFloat(stake);
  const isDemo = accountType === 'DEMO';
  const currentBal = isDemo ? user.demoBalance : user.realBalance;

  if (currentBal < numStake) return res.status(400).json({ error: "Insufficient account balance." });

  const market = markets[symbol];
  if (!market) return res.status(400).json({ error: "Invalid market." });

  // Deduct stake
  if (isDemo) user.demoBalance -= numStake;
  else user.realBalance -= numStake;

  const entryPrice = market.price;
  const entryDigit = parseInt(entryPrice.toFixed(2).slice(-1), 10);

  const trade = {
    id: 'TRD-' + Math.floor(Math.random() * 1000000),
    userId,
    accountType,
    symbol,
    symbolName: market.name,
    tradeType, // RISE, FALL, MATCH_DIGIT, DIFF_DIGIT, EVEN, ODD
    stake: numStake,
    entryPrice,
    entryDigit,
    targetDigit: targetDigit !== undefined ? parseInt(targetDigit, 10) : null,
    status: 'OPEN',
    createdAt: Date.now()
  };

  trades.push(trade);

  // Settle trade
  setTimeout(() => {
    const exitPrice = markets[symbol].price;
    const exitDigit = parseInt(exitPrice.toFixed(2).slice(-1), 10);
    let win = false;
    let payoutMultiplier = 0.95; // Default 95% payout

    if (tradeType === 'RISE') win = exitPrice > entryPrice;
    else if (tradeType === 'FALL') win = exitPrice < entryPrice;
    else if (tradeType === 'EVEN') win = exitDigit % 2 === 0;
    else if (tradeType === 'ODD') win = exitDigit % 2 !== 0;
    else if (tradeType === 'MATCH_DIGIT') {
      win = exitDigit === trade.targetDigit;
      payoutMultiplier = 8.5;
    } else if (tradeType === 'DIFF_DIGIT') {
      win = exitDigit !== trade.targetDigit;
      payoutMultiplier = 0.09;
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

    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) client.send(updatePayload);
    });

  }, (durationSeconds || 3) * 1000);

  res.json({ success: true, trade, demoBalance: user.demoBalance, realBalance: user.realBalance });
});

// -------------------------------------------------------------
// INTEGRATED AUTOMATED DEPOSITS & WITHDRAWALS
// -------------------------------------------------------------
app.post('/api/wallet/deposit', (req, res) => {
  const { userId, amount, paymentMethod } = req.body;
  const user = users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: "User not found." });

  const numAmount = parseFloat(amount);
  if (isNaN(numAmount) || numAmount <= 0) return res.status(400).json({ error: "Invalid amount." });

  // Integrated payment processing hook simulation
  user.realBalance += numAmount;

  const txn = {
    id: 'TXN-' + Date.now(),
    userId,
    type: 'DEPOSIT',
    amount: numAmount,
    method: paymentMethod || 'Instant Gateway',
    status: 'COMPLETED',
    timestamp: Date.now()
  };
  transactions.push(txn);

  res.json({ success: true, message: "Payment processed! Real balance updated.", realBalance: user.realBalance, transaction: txn });
});

// -------------------------------------------------------------
// DASHBOARD FRONTEND
// -------------------------------------------------------------
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>TraderScheme Synthetic Workstation</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    body { background-color: #0b0f19; color: #e5e7eb; font-family: system-ui, -apple-system, sans-serif; }
    .digit-badge { transition: all 0.2s ease; }
    .digit-badge.active { background-color: #2563eb; color: #ffffff; border-color: #60a5fa; transform: scale(1.15); font-weight: bold; }
  </style>
</head>
<body class="h-screen flex flex-col overflow-hidden">

  <!-- AUTHENTICATION OVERLAY MODAL -->
  <div id="authModal" class="fixed inset-0 bg-black/85 z-50 flex items-center justify-center p-4">
    <div class="bg-gray-900 border border-gray-800 w-full max-w-md rounded-2xl p-6 shadow-2xl">
      <h2 id="authTitle" class="text-2xl font-black text-blue-500 mb-6 text-center tracking-wider">DERIV WORKSTATION LOGIN</h2>
      <div class="space-y-4">
        <div>
          <label class="block text-xs text-gray-400 mb-1">Email Address</label>
          <input id="authEmail" type="email" placeholder="trader@example.com" class="w-full bg-gray-950 border border-gray-800 rounded-lg p-2.5 text-sm focus:border-blue-500 outline-none">
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

  <!-- PLATFORM HEADER NAVBAR -->
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

    <!-- ACCOUNT & BALANCE PANEL -->
    <div class="flex items-center gap-4">
      <div class="flex bg-gray-950 rounded-lg p-1 border border-gray-800">
        <button id="btnAccountDemo" onclick="setAccountType('DEMO')" class="px-3 py-1 text-xs font-bold rounded-md bg-blue-600 text-white">Demo</button>
        <button id="btnAccountReal" onclick="setAccountType('REAL')" class="px-3 py-1 text-xs font-bold rounded-md text-gray-400 hover:text-white">Real</button>
      </div>

      <div class="text-right">
        <div id="accountTypeLabel" class="text-[10px] uppercase font-bold text-blue-400">Demo Account</div>
        <div id="balanceDisplay" class="text-base font-black text-green-400">$10,000.00</div>
      </div>

      <button onclick="openDepositModal()" class="bg-green-600 hover:bg-green-500 font-bold text-xs px-4 py-2 rounded-lg transition">+ Deposit</button>
    </div>
  </header>

  <!-- TRADING DASHBOARD WORKSPACE -->
  <div class="grid grid-cols-12 flex-1 overflow-hidden">
    
    <!-- LEFT PANEL: CHART & HORIZONTAL DIGITS STREAM -->
    <div class="col-span-8 p-4 flex flex-col justify-between bg-gray-950/40 border-r border-gray-800">
      <div class="flex justify-between items-center mb-2">
        <div>
          <h2 id="activeMarketTitle" class="text-lg font-bold text-white">Volatility 10 (1s) Index</h2>
          <span id="priceChangeIndicator" class="text-xs text-gray-400">Live Synthetic Ticks</span>
        </div>
        <div class="text-3xl font-black text-green-400 tracking-wider" id="livePriceDisplay">0000.00</div>
      </div>

      <!-- CANVAS CHART CONTAINER -->
      <div class="flex-1 bg-gray-900/60 rounded-xl border border-gray-800/80 p-3 relative mb-4">
        <canvas id="marketChart"></canvas>
      </div>

      <!-- LINEAR HORIZONTAL DIGITS STREAM -->
      <div class="bg-gray-900 border border-gray-800 rounded-xl p-3">
        <div class="text-[11px] text-gray-400 font-semibold mb-2 flex justify-between">
          <span>LAST DIGIT TICK STREAM</span>
          <span id="digitRatioLabel">Even: 50% | Odd: 50%</span>
        </div>
        <div class="grid grid-cols-10 gap-2" id="horizontalDigitStream">
          <!-- Dynamically populated digit nodes 0-9 -->
        </div>
      </div>
    </div>

    <!-- RIGHT PANEL: CONTROL PANEL & EVEN/ODD CONTRACTS -->
    <div class="col-span-4 bg-gray-900 p-5 flex flex-col justify-between overflow-y-auto">
      <div class="space-y-4">
        
        <!-- Contract Selector Switcher -->
        <div>
          <label class="block text-xs font-bold text-gray-400 mb-1.5 uppercase">Contract Type</label>
          <select id="tradeTypeSelect" onchange="updateTradeForm()" class="w-full bg-gray-950 border border-gray-800 rounded-lg p-2.5 text-sm font-bold text-white outline-none">
            <option value="EVEN">Even / Odd</option>
            <option value="RISE">Rise / Fall</option>
            <option value="MATCH_DIGIT">Matches Last Digit</option>
            <option value="DIFF_DIGIT">Differs Last Digit</option>
          </select>
        </div>

        <!-- Target Prediction Digit (Matches/Differs) -->
        <div id="digitTargetWrapper" class="hidden">
          <label class="block text-xs font-bold text-gray-400 mb-1">Target Prediction Digit (0-9)</label>
          <input id="targetDigitInput" type="number" min="0" max="9" value="5" oninput="updateCalculations()" class="w-full bg-gray-950 border border-gray-800 rounded-lg p-2 text-sm font-bold text-white">
        </div>

        <!-- Stake & Duration Controls -->
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-xs font-bold text-gray-400 mb-1">Stake (USD)</label>
            <input id="stakeInput" type="number" value="10" oninput="updateCalculations()" class="w-full bg-gray-950 border border-gray-800 rounded-lg p-2.5 text-sm font-bold text-white outline-none">
          </div>
          <div>
            <label class="block text-xs font-bold text-gray-400 mb-1">Ticks (Duration)</label>
            <input id="durationInput" type="number" min="1" max="10" value="1" class="w-full bg-gray-950 border border-gray-800 rounded-lg p-2.5 text-sm font-bold text-white outline-none">
          </div>
        </div>

        <!-- LIVE PAYOUT / STAKE CALCULATION BOX -->
        <div class="bg-gray-950 border border-gray-800 rounded-lg p-3 space-y-1">
          <div class="flex justify-between text-xs text-gray-400">
            <span>Stake:</span>
            <span id="summaryStake" class="font-bold text-white">$10.00</span>
          </div>
          <div class="flex justify-between text-xs text-gray-400">
            <span>Payout Multiplier:</span>
            <span id="summaryPayout" class="font-bold text-green-400">$19.50 (95%)</span>
          </div>
        </div>

        <!-- ACTION BUTTON CONTAINER (EVEN/ODD DIRECT EXECUTION) -->
        <div id="actionButtonsContainer" class="grid grid-cols-2 gap-3 pt-2">
          <button onclick="executeTradeWithSide('EVEN')" class="bg-blue-600 hover:bg-blue-500 py-3 rounded-lg font-black text-sm uppercase tracking-wider">EVEN</button>
          <button onclick="executeTradeWithSide('ODD')" class="bg-red-600 hover:bg-red-500 py-3 rounded-lg font-black text-sm uppercase tracking-wider">ODD</button>
        </div>

      </div>

      <!-- TRADE LOG STREAM -->
      <div class="mt-4 border-t border-gray-800 pt-3">
        <h3 class="text-xs font-bold text-gray-400 uppercase mb-2">Trade Execution Log</h3>
        <div id="tradesLog" class="space-y-2 max-h-40 overflow-y-auto pr-1"></div>
      </div>
    </div>
  </div>

  <!-- AUTOMATED INTEGRATED DEPOSIT MODAL -->
  <div id="depositModal" class="fixed inset-0 bg-black/80 z-50 hidden flex items-center justify-center p-4">
    <div class="bg-gray-900 border border-gray-800 w-full max-w-md rounded-2xl p-6">
      <h3 class="text-lg font-bold text-white mb-2">Integrated Payment Gateway</h3>
      <p class="text-xs text-gray-400 mb-4">Process automated direct deposit into your Real balance.</p>
      <div class="space-y-4">
        <div>
          <label class="block text-xs text-gray-400 mb-1">Deposit Amount ($)</label>
          <input id="depositAmount" type="number" value="100" class="w-full bg-gray-950 border border-gray-800 rounded-lg p-2.5 text-sm font-bold text-white">
        </div>
        <div>
          <label class="block text-xs text-gray-400 mb-1">Payment Channel</label>
          <select id="depositMethod" class="w-full bg-gray-950 border border-gray-800 rounded-lg p-2.5 text-sm font-bold text-white">
            <option>Automated Credit / Debit Card</option>
            <option>Crypto Payment Gateway</option>
            <option>Mobile Wallet Processing</option>
          </select>
        </div>
        <button onclick="processIntegratedDeposit()" class="w-full bg-green-600 hover:bg-green-500 font-bold py-3 rounded-lg text-sm">Process Automated Deposit</button>
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

    // Initialize Horizontal Digits Bar (0-9)
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

    // Initialize Chart.js
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

    // WebSocket Engine Connection
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(\`\${protocol}//\${window.location.host}\`);

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'TICK_UPDATE') {
        const m = data.markets[activeSymbol];
        if (m) {
          document.getElementById('livePriceDisplay').innerText = m.price.toFixed(2);
          
          // Update Chart
          const prices = m.history.map(h => h.price);
          chartInstance.data.labels = prices.map(() => '');
          chartInstance.data.datasets[0].data = prices;
          chartInstance.update('none');

          // Highlight Active Digit in Stream
          const lastDigit = parseInt(m.price.toFixed(2).slice(-1), 10);
          document.querySelectorAll('.digit-badge').forEach(el => el.classList.remove('active'));
          const activeNode = document.getElementById('digit-node-' + lastDigit);
          if (activeNode) activeNode.classList.add('active');

          // Calculate Even/Odd Ratios
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
      } else if (type === 'RISE') {
        targetWrapper.classList.add('hidden');
        actionBox.innerHTML = \`
          <button onclick="executeTradeWithSide('RISE')" class="bg-green-600 hover:bg-green-500 py-3 rounded-lg font-black text-sm uppercase tracking-wider">RISE</button>
          <button onclick="executeTradeWithSide('FALL')" class="bg-red-600 hover:bg-red-500 py-3 rounded-lg font-black text-sm uppercase tracking-wider">FALL</button>
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
      let multiplier = 0.95;

      if (type === 'MATCH_DIGIT') multiplier = 8.5;
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

    function logTradeResult(trade) {
      const log = document.getElementById('tradesLog');
      const item = document.createElement('div');
      item.className = "bg-gray-950 p-2.5 rounded-lg border border-gray-800 text-xs";
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

    // AUTHENTICATION LOGIC
    function toggleAuthMode() {
      authMode = (authMode === 'LOGIN') ? 'REGISTER' : 'LOGIN';
      document.getElementById('authTitle').innerText = authMode === 'REGISTER' ? 'CREATE WORKSTATION ACCOUNT' : 'DERIV WORKSTATION LOGIN';
      document.getElementById('authSubmitBtn').innerText = authMode === 'REGISTER' ? 'Register Account' : 'Log In';
      document.getElementById('authToggleBtn').innerText = authMode === 'REGISTER' ? 'Already have an account? Login' : 'Need an account? Register';
    }

    async function submitAuth() {
      const email = document.getElementById('authEmail').value.trim();
      const password = document.getElementById('authPassword').value.trim();
      if (!email || !password) return alert("Please enter your credentials.");

      const endpoint = authMode === 'REGISTER' ? '/api/auth/register' : '/api/auth/login';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
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
        alert(\`AI Deep Scan Complete!\nBest Market: \${data.bestMarket.name}\nScore: \${data.bestMarket.score}%\nSignal: \${data.bestMarket.momentum}\`);
      }
    }

    function openDepositModal() { document.getElementById('depositModal').classList.remove('hidden'); }
    function closeDepositModal() { document.getElementById('depositModal').classList.add('hidden'); }

    async function processIntegratedDeposit() {
      if (!currentUser) return alert("Please log in first.");
      const amount = document.getElementById('depositAmount').value;
      const paymentMethod = document.getElementById('depositMethod').value;

      const res = await fetch('/api/wallet/deposit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: currentUser.id, amount, paymentMethod })
      });

      const data = await res.json();
      if (data.error) return alert(data.error);

      currentUser.realBalance = data.realBalance;
      setAccountType('REAL');
      alert(data.message);
      closeDepositModal();
    }

    // Initialize Form State
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
