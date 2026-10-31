CREATE TABLE `onboarding_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`file_name` text NOT NULL,
	`currency` text NOT NULL,
	`status` text NOT NULL,
	`signature` text NOT NULL,
	`spec_json` text NOT NULL,
	`rows_read` integer NOT NULL,
	`rows_checked` integer NOT NULL,
	`rows_outside_window` integer NOT NULL,
	`skipped_json` text NOT NULL,
	`period_from` text,
	`period_to` text,
	`totals_json` text,
	`error` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `onboarding_imports_business` ON `onboarding_imports` (`business_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `onboarding_mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`signature` text NOT NULL,
	`header_json` text NOT NULL,
	`spec_json` text NOT NULL,
	`used_count` integer DEFAULT 1 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `onboarding_mappings_business_signature` ON `onboarding_mappings` (`business_id`,`signature`);
--> statement-breakpoint
CREATE TABLE `onboarding_results` (
	`id` text PRIMARY KEY NOT NULL,
	`import_id` text NOT NULL,
	`business_id` text NOT NULL,
	`row` integer NOT NULL,
	`date` text NOT NULL,
	`payee` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`reference` text,
	`category` text NOT NULL,
	`verdict` text NOT NULL,
	`reason` text NOT NULL,
	`rules_json` text NOT NULL,
	`overpaid_minor` integer DEFAULT 0 NOT NULL,
	`duplicate_of_row` integer
);
--> statement-breakpoint
CREATE INDEX `onboarding_results_import` ON `onboarding_results` (`import_id`,`row`);
--> statement-breakpoint
CREATE INDEX `onboarding_results_business` ON `onboarding_results` (`business_id`,`date`);
--> statement-breakpoint
CREATE TABLE `onboarding_marks` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`result_id` text NOT NULL,
	`mark` text NOT NULL,
	`note` text,
	`marked_by` text NOT NULL,
	`marked_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `onboarding_marks_result` ON `onboarding_marks` (`result_id`);
--> statement-breakpoint
CREATE INDEX `onboarding_marks_business` ON `onboarding_marks` (`business_id`);
--> statement-breakpoint
CREATE TABLE `onboarding_suggestions` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`kind` text NOT NULL,
	`target` text NOT NULL,
	`title` text NOT NULL,
	`detail` text NOT NULL,
	`payload_json` text NOT NULL,
	`status` text NOT NULL,
	`decided_by` text,
	`decided_at` text,
	`decision_note` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `onboarding_suggestions_kind_target` ON `onboarding_suggestions` (`business_id`,`kind`,`target`);
--> statement-breakpoint
CREATE INDEX `onboarding_suggestions_status` ON `onboarding_suggestions` (`business_id`,`status`);
