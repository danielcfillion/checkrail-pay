CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`display_name` text NOT NULL,
	`role` text NOT NULL,
	`approval_limit_minor` integer,
	`delegate_to` text,
	`delegate_until` text,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `vendor_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`vendor_id` text,
	`kind` text NOT NULL,
	`proposed_json` text NOT NULL,
	`source` text NOT NULL,
	`requested_by` text NOT NULL,
	`status` text NOT NULL,
	`decided_by` text,
	`decided_at` text,
	`method` text,
	`note` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `vendor_changes_business_status` ON `vendor_changes` (`business_id`,`status`);
--> statement-breakpoint
CREATE TABLE `vendor_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`vendor_id` text,
	`label` text,
	`created_by` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vendor_invites_token_hash_unique` ON `vendor_invites` (`token_hash`);
--> statement-breakpoint
ALTER TABLE `vendors` ADD `status` text DEFAULT 'active' NOT NULL;
--> statement-breakpoint
ALTER TABLE `vendors` ADD `verified_by` text;
--> statement-breakpoint
ALTER TABLE `vendors` ADD `verification_method` text;
--> statement-breakpoint
ALTER TABLE `vendors` ADD `created_by` text;
--> statement-breakpoint
ALTER TABLE `vendors` ADD `default_account_code` text;
