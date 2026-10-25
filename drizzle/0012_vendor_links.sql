CREATE TABLE `vendor_links` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`kind` text NOT NULL,
	`token_hash` text NOT NULL,
	`obligation_id` text NOT NULL,
	`vendor_id` text NOT NULL,
	`note` text,
	`expires_at` text NOT NULL,
	`used_at` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vendor_links_token_hash_unique` ON `vendor_links` (`token_hash`);
