CREATE TABLE `bills` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`vendor_id` text NOT NULL,
	`kind` text NOT NULL,
	`reference` text NOT NULL,
	`total_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`bill_date` text,
	`due_date` text,
	`status` text NOT NULL,
	`note` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `bills_vendor` ON `bills` (`vendor_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `bills_vendor_ref_kind_unique` ON `bills` (`vendor_id`,`reference`,`kind`);
--> statement-breakpoint
CREATE TABLE `bill_allocations` (
	`id` text PRIMARY KEY NOT NULL,
	`credit_bill_id` text NOT NULL,
	`bill_id` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `obligations` ADD `bill_id` text;
--> statement-breakpoint
ALTER TABLE `obligations` ADD `payment_kind` text;
