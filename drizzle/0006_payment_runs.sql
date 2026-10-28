CREATE TABLE `payment_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`created_by` text NOT NULL,
	`released_by` text,
	`released_at` text,
	`cancelled_by` text,
	`note` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `payment_runs_business_status` ON `payment_runs` (`business_id`,`status`);
--> statement-breakpoint
CREATE TABLE `payment_run_items` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`obligation_id` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`rail` text,
	`status` text NOT NULL,
	`message` text,
	`created_at` text NOT NULL,
	`finished_at` text
);
--> statement-breakpoint
CREATE INDEX `payment_run_items_run` ON `payment_run_items` (`run_id`);
--> statement-breakpoint
CREATE INDEX `payment_run_items_obligation` ON `payment_run_items` (`obligation_id`);
