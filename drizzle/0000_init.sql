CREATE TABLE `accounting_syncs` (
	`id` text PRIMARY KEY NOT NULL,
	`obligation_id` text NOT NULL,
	`destination` text NOT NULL,
	`status` text NOT NULL,
	`external_ref` text,
	`payload_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`obligation_id` text NOT NULL,
	`actor` text NOT NULL,
	`decision` text NOT NULL,
	`note` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `audit_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`obligation_id` text,
	`seq` integer NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`from_state` text,
	`to_state` text,
	`detail_json` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_obligation` ON `audit_entries` (`obligation_id`);--> statement-breakpoint
CREATE TABLE `businesses` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`base_currency` text DEFAULT 'USD' NOT NULL,
	`country` text DEFAULT 'US' NOT NULL,
	`policy_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`external_event_id` text,
	`type` text NOT NULL,
	`payload_json` text NOT NULL,
	`processed_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`obligation_id` text NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`amount_minor` integer,
	`currency` text,
	`reference` text,
	`excerpt` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `obligations` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`vendor_id` text,
	`state` text NOT NULL,
	`source_type` text NOT NULL,
	`source_ref` text,
	`raw_input` text NOT NULL,
	`description` text,
	`amount_minor` integer,
	`currency` text,
	`due_date` text,
	`ai_summary` text,
	`ai_confidence` integer,
	`ai_flags_json` text,
	`ai_missing_json` text,
	`policy_decision` text,
	`policy_reasons_json` text,
	`selected_rail` text,
	`route_reason` text,
	`blocked_reason` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `obligations_business_state` ON `obligations` (`business_id`,`state`);--> statement-breakpoint
CREATE TABLE `payment_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`obligation_id` text NOT NULL,
	`rail` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`status` text NOT NULL,
	`external_id` text,
	`external_status` text,
	`request_json` text,
	`response_json` text,
	`error_message` text,
	`mode` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_attempts_idempotency_key_unique` ON `payment_attempts` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `attempts_obligation` ON `payment_attempts` (`obligation_id`);--> statement-breakpoint
CREATE TABLE `route_quotes` (
	`id` text PRIMARY KEY NOT NULL,
	`obligation_id` text NOT NULL,
	`rail` text NOT NULL,
	`available` integer NOT NULL,
	`unavailable_reason` text,
	`send_amount_minor` integer,
	`send_currency` text,
	`fee_minor` integer,
	`fx_rate` text,
	`receive_amount_minor` integer,
	`receive_currency` text,
	`eta_seconds` integer,
	`corridor` text,
	`provider` text,
	`explanation` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settlements` (
	`id` text PRIMARY KEY NOT NULL,
	`obligation_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`rail` text NOT NULL,
	`gross_minor` integer NOT NULL,
	`gross_currency` text NOT NULL,
	`fee_minor` integer NOT NULL,
	`received_minor` integer,
	`received_currency` text,
	`fx_rate` text,
	`external_id` text,
	`explorer_url` text,
	`settled_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `vendors` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`country` text NOT NULL,
	`email` text,
	`preferred_rail` text,
	`paypal_email` text,
	`stellar_account` text,
	`bank_country` text,
	`bank_currency` text,
	`bank_label` text,
	`details_hash` text NOT NULL,
	`verified_at` text,
	`notes` text,
	`created_at` text NOT NULL
);
