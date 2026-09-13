-- ============================================================
--  AVIATOR — Supabase / PostgreSQL Schema
--  Run this in your Supabase SQL Editor (Dashboard → SQL Editor)
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─────────────────────────────────────────────
--  USERS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    phone           VARCHAR(20) UNIQUE NOT NULL,
    username        VARCHAR(50) UNIQUE NOT NULL,
    password_hash   TEXT NOT NULL,
    balance         NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    bonus_balance   NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    referral_code   VARCHAR(12) UNIQUE NOT NULL,
    referred_by     UUID REFERENCES users(id),
    kyc_status      VARCHAR(20) DEFAULT 'pending',  -- pending | submitted | verified | rejected
    kyc_doc_url     TEXT,
    is_active       BOOLEAN DEFAULT TRUE,
    is_admin        BOOLEAN DEFAULT FALSE,
    daily_limit     NUMERIC(15,2) DEFAULT NULL,     -- NULL = no limit set
    self_excluded   BOOLEAN DEFAULT FALSE,
    self_excluded_until TIMESTAMPTZ DEFAULT NULL,
    first_deposit_done  BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
--  OTP CODES
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS otp_codes (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    phone       VARCHAR(20) NOT NULL,
    code        VARCHAR(6) NOT NULL,
    purpose     VARCHAR(20) NOT NULL,   -- register | login | withdraw
    used        BOOLEAN DEFAULT FALSE,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
--  TRANSACTIONS (Deposits & Withdrawals)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transactions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id),
    type            VARCHAR(20) NOT NULL,   -- deposit | withdrawal | bonus | referral
    amount          NUMERIC(15,2) NOT NULL,
    status          VARCHAR(20) DEFAULT 'pending', -- pending | completed | failed | cancelled
    provider        VARCHAR(30) DEFAULT 'instasend',
    provider_ref    TEXT,                   -- Instasend/M-Pesa transaction ID
    mpesa_receipt   TEXT,
    phone           VARCHAR(20),
    admin_note      TEXT,
    reviewed_by     UUID REFERENCES users(id),
    reviewed_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
--  GAME ROUNDS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS game_rounds (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    round_number    BIGSERIAL,
    seed_hash       TEXT NOT NULL,    -- SHA-256 hash published BEFORE round starts
    server_seed     TEXT NOT NULL,    -- revealed AFTER round ends (provably fair)
    crash_at        NUMERIC(8,2) NOT NULL,
    status          VARCHAR(20) DEFAULT 'waiting', -- waiting | flying | crashed
    started_at      TIMESTAMPTZ,
    crashed_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
--  BETS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bets (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id),
    round_id        UUID NOT NULL REFERENCES game_rounds(id),
    amount          NUMERIC(15,2) NOT NULL,
    auto_cashout    NUMERIC(8,2) DEFAULT NULL,  -- NULL = manual cashout
    cashed_out_at   NUMERIC(8,2) DEFAULT NULL,  -- multiplier at cashout
    payout          NUMERIC(15,2) DEFAULT 0.00,
    status          VARCHAR(20) DEFAULT 'active', -- active | won | lost
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
--  REFERRALS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS referrals (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    referrer_id     UUID NOT NULL REFERENCES users(id),
    referred_id     UUID NOT NULL REFERENCES users(id),
    referrer_bonus  NUMERIC(15,2) DEFAULT 20.00,
    referred_bonus  NUMERIC(15,2) DEFAULT 10.00,
    paid_out        BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────
--  INDEXES (speed up common queries)
-- ─────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_bets_user ON bets(user_id);
CREATE INDEX IF NOT EXISTS idx_bets_round ON bets(round_id);
CREATE INDEX IF NOT EXISTS idx_otp_phone ON otp_codes(phone, purpose);
CREATE INDEX IF NOT EXISTS idx_game_rounds_status ON game_rounds(status);

-- ─────────────────────────────────────────────
--  AUTO-UPDATE updated_at on row changes
-- ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_transactions_updated
    BEFORE UPDATE ON transactions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Done! Your schema is ready.
