const mongoose = require('mongoose');

// User Schema with Authentication and Wallet Details
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  resetToken: { type: String, default: null },
  resetTokenExpiry: { type: Date, default: null },
  balance: { type: Number, default: 1000.00 },
  createdAt: { type: Date, default: Date.now }
});

// Trade Schema for Manual and Automated Executions
const tradeSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  symbol: { type: String, required: true },
  tradeType: { type: String, required: true }, // RISE, FALL, DIGITMATCH, DIGITDIFF
  stake: { type: Number, required: true },
  entryPrice: { type: Number, required: true },
  entryLastDigit: { type: Number, required: true },
  predictionDigit: { type: Number, default: null },
  exitPrice: { type: Number, default: null },
  exitLastDigit: { type: Number, default: null },
  payout: { type: Number, default: 0 },
  status: { type: String, enum: ['OPEN', 'WIN', 'LOSS'], default: 'OPEN' },
  mode: { type: String, enum: ['MANUAL', 'AUTO'], default: 'MANUAL' },
  createdAt: { type: Date, default: Date.now }
});

// Transaction Schema for Deposits and Withdrawals
const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { type: String, enum: ['DEPOSIT', 'WITHDRAWAL'], required: true },
  amount: { type: Number, required: true },
  status: { type: String, enum: ['PENDING', 'COMPLETED', 'FAILED'], default: 'PENDING' },
  reference: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

module.exports = {
  User: mongoose.model('User', userSchema),
  Trade: mongoose.model('Trade', tradeSchema),
  Transaction: mongoose.model('Transaction', transactionSchema)
};
