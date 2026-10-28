ALTER TABLE `vendors` ADD `bank_account_enc` text;
--> statement-breakpoint
ALTER TABLE `vendors` ADD `bank_code` text;
--> statement-breakpoint
ALTER TABLE `vendors` ADD `account_holder` text;
--> statement-breakpoint
CREATE TABLE `bank_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`currency` text NOT NULL,
	`status` text NOT NULL,
	`source_account` text NOT NULL,
	`created_at` text NOT NULL,
	`downloaded_at` text,
	`downloaded_by` text,
	`confirmed_at` text,
	`confirmed_by` text
);
--> statement-breakpoint
CREATE TABLE `bank_batch_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`obligation_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`beneficiary_name` text NOT NULL,
	`bank_code` text NOT NULL,
	`account_enc` text NOT NULL,
	`memo` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bank_batch_lines_key_unique` ON `bank_batch_lines` (`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `bank_batch_lines_batch` ON `bank_batch_lines` (`batch_id`);
