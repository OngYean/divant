-- Add a timestamp column to record the last action performed inside a pool.
-- Run this once against your MySQL database.

ALTER TABLE `pool`
  ADD COLUMN `last_action_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) AFTER `last_active_at`;

-- Optional: backfill `last_action_at` from `last_active_at` if you want historical continuity
-- UPDATE `pool` SET last_action_at = last_active_at WHERE last_action_at IS NULL;
