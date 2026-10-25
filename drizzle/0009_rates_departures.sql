CREATE TABLE `rate_cards` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`vendor_id` text NOT NULL,
	`unit` text NOT NULL,
	`rate_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`valid_from` text NOT NULL,
	`valid_to` text,
	`note` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rate_cards_vendor` ON `rate_cards` (`vendor_id`);
--> statement-breakpoint
CREATE TABLE `departures` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`code` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`guests` integer NOT NULL,
	`source` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `departures_business_code_unique` ON `departures` (`business_id`,`code`);
--> statement-breakpoint
CREATE TABLE `departure_services` (
	`id` text PRIMARY KEY NOT NULL,
	`departure_id` text NOT NULL,
	`vendor_id` text NOT NULL,
	`unit` text NOT NULL,
	`quantity` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `departure_services_departure` ON `departure_services` (`departure_id`);
