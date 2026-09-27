-- RentMaster V7 migration 001
-- Adds the refundable security deposit and records how each payment arrived.
-- Safe to run more than once.

-- Refundable deposit held against a rental. Default LKR 5000, editable at checkout.
ALTER TABLE rentals ADD COLUMN IF NOT EXISTS deposit NUMERIC(10, 2) NOT NULL DEFAULT 5000;

-- How a payment was received.
DO $$ BEGIN
  CREATE TYPE payment_method AS ENUM ('cash', 'bank_transfer', 'online');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 'cash' default keeps existing rows and the equipment-return insert valid.
ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS method payment_method NOT NULL DEFAULT 'cash';

-- Bank/online transaction reference, or a short note for cash.
ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS reference VARCHAR(120);
