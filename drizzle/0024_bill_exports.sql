CREATE TABLE `bill_exports` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`actor` text NOT NULL,
	`bill_count` integer NOT NULL,
	`file_name` text NOT NULL,
	`content` text NOT NULL,
	`sha256` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `bill_exports_business_created` ON `bill_exports` (`business_id`,`created_at`);
