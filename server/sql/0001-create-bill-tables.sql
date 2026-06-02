-- Create bill and bill_share tables for expense tracking.
-- Run this once against your MySQL database.

CREATE TABLE IF NOT EXISTS `bill` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `pool_id` VARCHAR(32) NOT NULL,
  `created_by_user_id` VARCHAR(32) NOT NULL,
  `title` VARCHAR(255) NOT NULL,
  `total_amount` DECIMAL(10, 2) NOT NULL,
  `currency` VARCHAR(3) NOT NULL DEFAULT 'USD',
  `split_mode` ENUM('equal', 'custom', 'fixed') NOT NULL DEFAULT 'equal',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  FOREIGN KEY (`pool_id`) REFERENCES `pool`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE,
  KEY `idx_pool_id` (`pool_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `bill_share` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `bill_id` INT NOT NULL,
  `user_id` VARCHAR(32) NOT NULL,
  `share_type` ENUM('equal', 'custom', 'fixed') NOT NULL DEFAULT 'equal',
  `share_value` DECIMAL(10, 2),
  `share_amount` DECIMAL(10, 2) NOT NULL,
  UNIQUE KEY `unique_bill_user` (`bill_id`, `user_id`),
  FOREIGN KEY (`bill_id`) REFERENCES `bill`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE,
  KEY `idx_bill_id` (`bill_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
