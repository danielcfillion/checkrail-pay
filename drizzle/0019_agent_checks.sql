CREATE TABLE `agent_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`agent` text NOT NULL,
	`tool` text NOT NULL,
	`verdict` text NOT NULL,
	`payee` text,
	`payee_key` text,
	`amount_minor` integer,
	`currency` text,
	`reference` text,
	`summary` text NOT NULL,
	`rules_json` text,
	`obligation_id` text,
	`idempotency_key` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agent_checks_business` ON `agent_checks` (`business_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `agent_checks_probe` ON `agent_checks` (`agent`,`payee_key`,`created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_checks_idem` ON `agent_checks` (`agent`,`idempotency_key`);
