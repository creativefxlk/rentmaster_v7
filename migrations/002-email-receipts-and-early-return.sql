-- RentMaster V7 migration 002
-- Client email, early-return recalculation, and deposit deductions.
-- Safe to run more than once.

-- Where receipts are sent. Optional: a rental may be walk-in with no email.
ALTER TABLE customers ADD COLUMN IF NOT EXISTS email VARCHAR(255);

-- The agreed daily rate is frozen onto the rental at checkout, so an early
-- return recalculates against the price the client actually agreed to, even if
-- the equipment's list price changes later.
ALTER TABLE rentals ADD COLUMN IF NOT EXISTS daily_price NUMERIC(10, 2) NOT NULL DEFAULT 0;

-- Agreed period, kept so the final receipt can show booked vs actual days.
ALTER TABLE rentals ADD COLUMN IF NOT EXISTS booked_days INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rentals ADD COLUMN IF NOT EXISTS actual_days INTEGER;

-- Damage or late-return withholding taken from the refundable deposit.
ALTER TABLE rentals ADD COLUMN IF NOT EXISTS deposit_deduction NUMERIC(10, 2) NOT NULL DEFAULT 0;
ALTER TABLE rentals ADD COLUMN IF NOT EXISTS deposit_deduction_reason VARCHAR(255);

-- Overpayment returned to the client on an early return. Stored as a negative
-- ledger amount so SUM(amount) over the ledger stays truthful.
ALTER TYPE payment_type ADD VALUE IF NOT EXISTS 'refund';

-- Backfill the frozen rate for any rental predating this migration.
UPDATE rentals r SET daily_price = e.daily_price FROM equipment e WHERE r.equipment_id = e.id AND r.daily_price = 0;
