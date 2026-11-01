CREATE TABLE `xero_connections` (
	`business_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`tenant_name` text,
	`connection_id` text,
	`access_token_enc` text NOT NULL,
	`refresh_token_enc` text NOT NULL,
	`access_expires_at` text NOT NULL,
	`scopes` text,
	`status` text NOT NULL,
	`connected_by` text NOT NULL,
	`connected_at` text NOT NULL,
	`sync_from` text NOT NULL,
	`expense_account_code` text,
	`paypal_account_code` text,
	`stellar_account_code` text,
	`bank_account_code` text,
	`fee_account_code` text,
	`withholding_account_code` text,
	`tax_type` text,
	`chart_json` text,
	`chart_fetched_at` text,
	`blocked_until` text,
	`last_push_at` text,
	`last_error` text,
	`lease_owner` text,
	`lease_until` text,
	`rate_window_start` integer,
	`rate_window_calls` integer DEFAULT 0 NOT NULL,
	`chart_attempts` integer DEFAULT 0 NOT NULL,
	`chart_retry_at` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `xero_oauth_states` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`login` text NOT NULL,
	`actor` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `xero_records` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`kind` text NOT NULL,
	`local_key` text NOT NULL,
	`parent_key` text,
	`amount` text,
	`label` text NOT NULL,
	`obligation_id` text,
	`accounting_sync_id` text,
	`xero_id` text,
	`status` text NOT NULL,
	`error` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`key_seq` integer DEFAULT 0 NOT NULL,
	`idem_key` text,
	`sent_hash` text,
	`uncertain` integer DEFAULT false NOT NULL,
	`next_attempt_at` text,
	`pushed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `xero_records_key` ON `xero_records` (`business_id`,`tenant_id`,`kind`,`local_key`);
--> statement-breakpoint
CREATE INDEX `xero_records_status` ON `xero_records` (`business_id`,`status`);
