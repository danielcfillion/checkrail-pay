ALTER TABLE `evidence` ADD `provenance` text;--> statement-breakpoint
ALTER TABLE `obligations` ADD `payout_hash` text;--> statement-breakpoint
ALTER TABLE `settlements` ADD `note` text;--> statement-breakpoint
CREATE UNIQUE INDEX `audit_seq_unique` ON `audit_entries` (`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `events_external_event_id_unique` ON `events` (`external_event_id`);