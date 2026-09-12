const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());

// Global System State
let systemSettings = {
  payoutRate: 0.85,
  marketPaused: false,
  targetVol: 0.8
};

let userAccount = {
  balance: 1000.00,
  activeTrades: []
};

let currentPrice = 6500.00;

// Synthetic Volatility Generator
setInterval(() => {
  if (!systemSettings.marketPaused) {
    const change = (Math.random() - 0.49) * systemSettings.targetVol * 10;
    currentPrice = parseFloat((currentPrice + change).toFixed(2));
  }

  const now = Date.now();
  userAccount.activeTrades.forEach((trade) => {
    if (!trade.settled && now >= trade.expiryTime) {
      trade.settled = true;
      const win = trade.type === 'RISE' ? currentPrice > trade.entryPrice : currentPrice < trade.entryPrice;
      if (win) {
        const payout = trade.stake + (trade.stake * systemSettings.payoutRate);
        userAccount.balance += payout;
        trade.result = `WIN (+ $${payout.toFixed(2)})`;
      } else {
        trade.result = `LOSS (- $${trade.stake.toFixed(2)})`;
      }
    }
  });

  broadcastState();
}, 1000);

function broadcastState() {
  const payload = JSON.stringify({
    type: 'SYSTEM_TICK',
    symbol: 'Volatility 75 Index',
    price: currentPrice,
    balance: userAccount.balance,
    trades: userAccount.activeTrades.slice(-10),
    connectedClients: wss.clients.size,
    settings: systemSettings
  });

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

// APIs
app.post('/api/trade', (req, res) => {
  if (systemSettings.marketPaused) {
    return res.status(403).json({ error: "Trading is temporarily paused" });
  }
  const { type, stake, durationSeconds } = req.body;
  if (userAccount.balance < stake) return res.status(400).json({ error: "Insufficient balance" });

  userAccount.balance -= stake;
  const newTrade = {
    id: 'TRD-' + Math.floor(Math.random() * 100000),
    type,
    stake: parseFloat(stake),
    entryPrice: currentPrice,
    expiryTime: Date.now() + (durationSeconds * 1000),
    settled: false,
    result: 'PENDING'
  };

  userAccount.activeTrades.push(newTrade);
  broadcastState();
  res.json({ success: true, trade: newTrade });
});

app.post('/api/deposit/create', (req, res) => {
  const { amount } = req.body;
  const depositId = 'DEP-' + Math.floor(100000 + Math.random() * 900000);
  res.json({
    success: true,
    paymentUrl: `/checkout-demo?id=${depositId}&amount=${amount}`
  });
});

app.post('/api/webhooks/payment', (req, res) => {
  const { amount, status, secret_key } = req.body;
  if (secret_key !== "MY_WEBHOOK_SECRET_123") {
    return res.status(401).json({ error: "Unauthorized webhook" });
  }
  if (status === 'SUCCESS' || status === 'COMPLETED') {
    userAccount.balance += parseFloat(amount);
    broadcastState();
    return res.json({ success: true, newBalance: userAccount.balance });
  }
  res.status(400).json({ error: "Payment failed" });
});

app.post('/api/admin/update', (req, res) => {
  const { balance, payoutRate, marketPaused } = req.body;
  if (balance !== undefined) userAccount.balance = parseFloat(balance);
  if (payoutRate !== undefined) systemSettings.payoutRate = parseFloat(payoutRate);
  if (marketPaused !== undefined) systemSettings.marketPaused = Boolean(marketPaused);
  broadcastState();
  res.json({ success: true });
});

// Client Page
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Deriv Synthetics Trader</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-900 text-white font-sans">
  <div id="pauseOverlay" class="hidden fixed inset-0 bg-red-900/90 z-50 flex items-center justify-center text-3xl font-black">
    MARKET PAUSED BY ADMIN
  </div>
  <div class="flex h-screen">
    <div class="w-64 bg-gray-800 p-4 border-r border-gray-700 flex flex-col justify-between">
      <div>
        <h1 class="text-xl font-bold text-red-500 mb-6">DERIV SYNTHETICS</h1>
        <p class="text-xs text-gray-400">Account Balance</p>
        <p id="balance" class="text-2xl font-black text-green-400">$1,000.00</p>
        <button onclick="depositModal()" class="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold py-2 mt-3 rounded text-sm">+ Deposit Funds</button>
        <div class="mt-4 p-2 bg-gray-900 rounded border border-gray-700">
          <p class="text-xs text-gray-400">Current Payout Rate</p>
          <p id="clientPayout" class="text-lg font-bold text-yellow-400">85%</p>
        </div>
      </div>
    </div>
    <div class="flex-1 p-6 flex flex-col justify-between">
      <div class="flex justify-between items-center mb-4">
        <h2 class="text-lg font-bold">Volatility 75 Index</h2>
        <div class="text-3xl font-black" id="livePrice">6500.00</div>
      </div>
      <div class="bg-gray-800 p-4 rounded-lg grid grid-cols-3 gap-4 items-center">
        <div>
          <label class="block text-xs text-gray-400 mb-1">Stake ($)</label>
          <input id="stake" type="number" value="50" class="w-full bg-gray-900 border border-gray-700 rounded p-2 font-bold">
        </div>
        <div>
          <label class="block text-xs text-gray-400 mb-1">Duration (Sec)</label>
          <input id="duration" type="number" value="5" class="w-full bg-gray-900 border border-gray-700 rounded p-2 font-bold">
        </div>
        <div class="flex gap-2">
          <button onclick="placeTrade('RISE')" class="flex-1 bg-green-600 font-bold py-3 rounded">RISE ↑</button>
          <button onclick="placeTrade('FALL')" class="flex-1 bg-red-600 font-bold py-3 rounded">FALL ↓</button>
        </div>
      </div>
    </div>
    <div class="w-80 bg-gray-800 p-4 border-l border-gray-700">
      <h3 class="text-sm font-bold mb-4">Trade History</h3>
      <div id="tradesLog" class="space-y-2"></div>
    </div>
  </div>
  <script>
    const ws = new WebSocket(\`ws://\${window.location.host}\`);
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if(data.type === 'SYSTEM_TICK') {
        document.getElementById('livePrice').innerText = data.price.toFixed(2);
        document.getElementById('balance').innerText = '$' + data.balance.toFixed(2);
        document.getElementById('clientPayout').innerText = (data.settings.payoutRate * 100) + '%';
        const overlay = document.getElementById('pauseOverlay');
        if (data.settings.marketPaused) overlay.classList.remove('hidden');
        else overlay.classList.add('hidden');
        renderTrades(data.trades);
      }
    };
    function renderTrades(trades) {
      document.getElementById('tradesLog').innerHTML = trades.map(t => \`
        <div class="bg-gray-900 p-2 rounded text-xs border border-gray-700">
          <div class="flex justify-between font-bold">
            <span>\${t.type} @ \${t.entryPrice}</span>
            <span class="\${t.result.includes('WIN') ? 'text-green-400' : 'text-red-400'}">\${t.result}</span>
          </div>
        </div>
      \`).reverse().join('');
    }
    async function placeTrade(type) {
      const stake = document.getElementById('stake').value;
      const durationSeconds = document.getElementById('duration').value;
      const res = await fetch('/api/trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, stake: parseFloat(stake), durationSeconds: parseInt(durationSeconds) })
      });
      const data = await res.json();
      if(data.error) alert(data.error);
    }
    async function depositModal() {
      const amount = prompt("Enter amount to deposit ($):", "100");
      if(!amount) return;
      const res = await fetch('/api/deposit/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: parseFloat(amount) })
      });
      const data = await res.json();
      if(data.paymentUrl) window.open(data.paymentUrl, '_blank');
    }
  </script>
</body>
</html>
  `);
});

// Admin Panel
app.get('/admin', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Broker Control Panel</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-950 text-white font-sans p-6">
  <div class="max-w-6xl mx-auto">
    <div class="flex justify-between items-center mb-8 border-b border-gray-800 pb-4">
      <h1 class="text-2xl font-bold text-red-500">DERIV ADMIN PANEL</h1>
      <div class="bg-blue-900/40 text-blue-400 border border-blue-700 px-4 py-2 rounded text-sm font-semibold">
        Connected Sessions: <span id="clientCount">0</span>
      </div>
    </div>
    <div class="grid grid-cols-3 gap-6 mb-8">
      <div class="bg-gray-900 p-4 rounded border border-gray-800">
        <h3 class="text-sm font-bold text-gray-400 mb-2">Adjust Client Balance</h3>
        <input id="adminBalance" type="number" class="w-full bg-gray-800 border border-gray-700 p-2 rounded font-bold mb-2">
        <button onclick="updateSettings()" class="w-full bg-blue-600 py-2 rounded font-bold text-xs">Set New Balance</button>
      </div>
      <div class="bg-gray-900 p-4 rounded border border-gray-800">
        <h3 class="text-sm font-bold text-gray-400 mb-2">Payout Ratio</h3>
        <select id="adminPayout" class="w-full bg-gray-800 border border-gray-700 p-2 rounded font-bold mb-2">
          <option value="0.95">95% Return</option>
          <option value="0.85" selected>85% Return</option>
          <option value="0.50">50% Return</option>
        </select>
        <button onclick="updateSettings()" class="w-full bg-blue-600 py-2 rounded font-bold text-xs">Apply Payout Rate</button>
      </div>
      <div class="bg-gray-900 p-4 rounded border border-gray-800">
        <h3 class="text-sm font-bold text-gray-400 mb-2">Market Emergency Halt</h3>
        <button id="pauseBtn" onclick="togglePause()" class="w-full bg-yellow-600 py-4 rounded font-bold text-sm">Halt Market</button>
      </div>
    </div>
  </div>
  <script>
    const ws = new WebSocket(\`ws://\${window.location.host}\`);
    let isPaused = false;
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if(data.type === 'SYSTEM_TICK') {
        document.getElementById('clientCount').innerText = data.connectedClients;
        document.getElementById('adminBalance').value = data.balance.toFixed(2);
        isPaused = data.settings.marketPaused;
        const btn = document.getElementById('pauseBtn');
        btn.innerText = isPaused ? "RESUME MARKET" : "HALT MARKET";
        btn.className = isPaused ? "w-full bg-green-600 py-4 rounded font-bold" : "w-full bg-red-600 py-4 rounded font-bold";
      }
    };
    async function updateSettings() {
      const balance = document.getElementById('adminBalance').value;
      const payoutRate = document.getElementById('adminPayout').value;
      await fetch('/api/admin/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ balance: parseFloat(balance), payoutRate: parseFloat(payoutRate) })
      });
    }
    async function togglePause() {
      await fetch('/api/admin/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marketPaused: !isPaused })
      });
    }
  </script>
</body>
</html>
  `);
});

// START SERVER AT THE VERY BOTTOM
const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
