ALTER TABLE `agent_checks` ADD `provenance_json` text;
--> statement-breakpoint
ALTER TABLE `agent_checks` ADD `mandate_id` text;
--> statement-breakpoint
CREATE INDEX `agent_checks_mandate` ON `agent_checks` (`mandate_id`);
--> statement-breakpoint
CREATE TABLE `agent_mandates` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`agent` text NOT NULL,
	`payees_json` text NOT NULL,
	`roles_json` text NOT NULL,
	`per_payment_minor` integer NOT NULL,
	`total_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`purpose` text,
	`note` text,
	`valid_from` text NOT NULL,
	`valid_until` text NOT NULL,
	`token` text NOT NULL,
	`token_hash` text NOT NULL,
	`issued_by` text NOT NULL,
	`created_at` text NOT NULL,
	`revoked_at` text,
	`revoked_by` text
);
--> statement-breakpoint
CREATE INDEX `agent_mandates_business` ON `agent_mandates` (`business_id`,`created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_mandates_token_hash` ON `agent_mandates` (`token_hash`);
--> statement-breakpoint
CREATE TABLE `agent_offers` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`agent` text NOT NULL,
	`vendor_id` text NOT NULL,
	`check_id` text NOT NULL,
	`obligation_id` text,
	`asked_minor` integer NOT NULL,
	`offer_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`reference` text,
	`basis_rule` text NOT NULL,
	`basis` text NOT NULL,
	`request_json` text NOT NULL,
	`status` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	`decided_at` text,
	`result_obligation_id` text,
	`dispute_reason` text,
	`dispute_evidence_json` text
);
--> statement-breakpoint
CREATE INDEX `agent_offers_business` ON `agent_offers` (`business_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `agent_offers_obligation` ON `agent_offers` (`obligation_id`);
--> statement-breakpoint
CREATE INDEX `agent_offers_agent` ON `agent_offers` (`agent`,`vendor_id`);
