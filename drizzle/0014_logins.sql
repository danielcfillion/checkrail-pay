ALTER TABLE `approvals` ADD `login` text;
--> statement-breakpoint
ALTER TABLE `vendor_changes` ADD `requested_login` text;
--> statement-breakpoint
ALTER TABLE `payment_runs` ADD `created_login` text;
