# Aviator Backend 🛩️

Full backend for the Aviator crash betting game. Built with Node.js, Express, Socket.io, PostgreSQL (Supabase), Africa's Talking OTP, and Instasend M-Pesa.

**100% free to host and run during development.**

---

## Stack

| Layer | Service | Cost |
|-------|---------|------|
| Backend | Node.js + Express | Free |
| Real-time | Socket.io | Free |
| Database | Supabase (PostgreSQL) | Free tier |
| Hosting | Railway | Free tier |
| OTP SMS | Africa's Talking | Free sandbox |
| M-Pesa | Instasend | Pay-per-use |

---

## Setup Guide (Step by Step)

### Step 1 — Supabase (Database)

1. Go to [supabase.com](https://supabase.com) → Create account → New project
2. Pick a region close to Kenya (Europe West is closest)
3. Go to **SQL Editor** → paste the entire contents of `database_schema.sql` → Run
4. Go to **Settings → Database** → copy the **Connection string (URI)**
5. That's your `DATABASE_URL` in `.env`

### Step 2 — Africa's Talking (Free OTP)

1. Go to [africastalking.com](https://africastalking.com) → Sign up
2. Create an app → go to **API Key** section → copy your key
3. In sandbox mode: set `AT_USERNAME=sandbox` in `.env`
4. In sandbox, OTPs are shown in their dashboard (no SMS sent) — free forever for testing
5. For production: top up as little as KES 5, set your real username

### Step 3 — Instasend (M-Pesa)

1. Go to [instasend.io](https://instasend.io) → Create merchant account
2. Dashboard → **API Keys** → copy API Key and Secret
3. For sandbox/testing use: `INSTASEND_BASE_URL=https://sandbox.instasend.io`
4. Add your backend URL as callback: `https://your-app.railway.app/api/payments/callback`

### Step 4 — Setup Environment

```bash
cp .env.example .env
# Fill in all values in .env
```

### Step 5 — Run Locally

```bash
npm install
npm run dev
```

Visit `http://localhost:3000/health` — you should see `{"status":"ok"}`

### Step 6 — Deploy to Railway (Free)

1. Go to [railway.app](https://railway.app) → Login with GitHub
2. New Project → Deploy from GitHub repo → select your repo
3. Add environment variables (copy from your `.env`)
4. Railway auto-detects Node.js and deploys
5. Your URL will be `https://your-app-name.railway.app`
6. Update `APP_URL` in Railway env vars with this URL

### Step 7 — Create Admin Account

After deploying, run this SQL in Supabase SQL Editor:

```sql
UPDATE users SET is_admin = TRUE WHERE phone = '+254XXXXXXXXX';
```

---

## API Reference

### Auth
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register/request-otp` | Step 1: request OTP |
| POST | `/api/auth/register/verify` | Step 2: verify OTP + create account |
| POST | `/api/auth/login/request-otp` | Request login OTP |
| POST | `/api/auth/login/verify` | Verify OTP + get JWT token |

### Payments
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/payments/deposit` | Initiate M-Pesa STK push |
| POST | `/api/payments/callback` | Instasend webhook (auto-called) |
| POST | `/api/payments/withdraw/request-otp` | Get OTP for withdrawal |
| POST | `/api/payments/withdraw` | Submit withdrawal request |
| GET  | `/api/payments/transactions` | User's transaction history |
| GET  | `/api/payments/admin/pending` | 🔒 Admin: pending withdrawals |
| POST | `/api/payments/admin/approve/:id` | 🔒 Admin: approve withdrawal |
| POST | `/api/payments/admin/reject/:id` | 🔒 Admin: reject withdrawal |

### Game
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET  | `/api/game/state` | Current round state |
| POST | `/api/game/bet` | Place a bet |
| POST | `/api/game/cashout` | Cash out current bet |
| GET  | `/api/game/history` | Recent round results |
| GET  | `/api/game/my-bets` | User's bet history |
| GET  | `/api/game/leaderboard` | Today's top winners |

### User
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET  | `/api/user/profile` | User profile + balance |
| POST | `/api/user/kyc` | Submit KYC document |
| POST | `/api/user/limits` | Set deposit limits / self-exclude |
| GET  | `/api/user/referrals` | Referral history + earnings |

### Socket.io Events

**Server → Client:**
- `round:waiting` — New round starting, betting open
- `round:started` — Round flying
- `round:tick` — Multiplier update (every 100ms)
- `round:crashed` — Round ended, seed revealed
- `cashout:success` — Your cashout was processed
- `game:state` — Full state on connect

**Client → Server:**
- `auth` — Send JWT token to join private room

---

## Security Features

- JWT authentication with 7-day expiry
- Helmet.js HTTP security headers
- Rate limiting (auth: 10/15min, OTP: 5/10min, payments: 20/hr)
- OTP required for withdrawals
- KYC required before first withdrawal
- Self-exclusion and daily deposit limits
- Provably fair RNG (server seed revealed after each round)
- SQL injection protection via parameterized queries
- Admin withdrawal approval queue

---

## Connecting to Your Frontend

In your `aviator-preview-1.html`, replace mock API calls with:

```javascript
const API_BASE = 'https://your-app.railway.app';
const socket = io(API_BASE);

// Auth header for all requests
const headers = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${localStorage.getItem('token')}`
};

// Example: place a bet
const res = await fetch(`${API_BASE}/api/game/bet`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ amount: 100, auto_cashout: 2.5 })
});

// Listen for game events
socket.on('round:tick', ({ multiplier }) => {
  updateMultiplierDisplay(multiplier);
});
socket.on('round:crashed', ({ crashAt, serverSeed }) => {
  showCrash(crashAt, serverSeed);
});
```
