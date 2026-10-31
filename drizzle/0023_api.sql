CREATE TABLE `api_idempotency` (
	`id` text PRIMARY KEY NOT NULL,
	`key_name` text NOT NULL,
	`idem_key` text NOT NULL,
	`method` text NOT NULL,
	`path` text NOT NULL,
	`body_sha256` text NOT NULL,
	`status` integer,
	`response_json` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_idempotency_key` ON `api_idempotency` (`key_name`,`idem_key`);
--> statement-breakpoint
CREATE INDEX `api_idempotency_created` ON `api_idempotency` (`created_at`);
--> statement-breakpoint
CREATE TABLE `api_departure_refs` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`external_id` text NOT NULL,
	`departure_id` text NOT NULL,
	`key_name` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_departure_refs_external` ON `api_departure_refs` (`business_id`,`external_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_departure_refs_departure` ON `api_departure_refs` (`departure_id`);
--> statement-breakpoint
CREATE TABLE `api_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`key_name` text NOT NULL,
	`obligation_id` text NOT NULL,
	`reference` text,
	`idem_key` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_requests_obligation` ON `api_requests` (`obligation_id`);
--> statement-breakpoint
CREATE INDEX `api_requests_key_reference` ON `api_requests` (`key_name`,`reference`);
--> statement-breakpoint
CREATE TABLE `api_key_usage` (
	`key_name` text PRIMARY KEY NOT NULL,
	`last_used_at` text NOT NULL,
	`last_path` text,
	`calls` integer DEFAULT 0 NOT NULL
);
