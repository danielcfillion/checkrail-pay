ALTER TABLE `settlements` ADD `reconciled_at` text;
--> statement-breakpoint
ALTER TABLE `settlements` ADD `statement_ref` text;
--> statement-breakpoint
ALTER TABLE `businesses` ADD `locked_through` text;
--> statement-breakpoint
CREATE TABLE `reconciliations` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`source` text NOT NULL,
	`file_name` text,
	`period_from` text,
	`period_to` text,
	`summary_json` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL
);
