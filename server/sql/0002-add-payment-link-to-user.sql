-- Migration: Add payment_link column to user table
-- This adds a nullable VARCHAR(255) column to store optional payment link or QR URL
ALTER TABLE `user`
ADD COLUMN `payment_link` VARCHAR(255) NULL AFTER `session_token_hash`;
