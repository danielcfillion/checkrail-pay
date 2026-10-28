ALTER TABLE `evidence` ADD `attachment_id` text;--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`business_id` text NOT NULL,
	`obligation_id` text,
	`name` text NOT NULL,
	`mime_type` text NOT NULL,
	`bytes` blob NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`extracted_text` text,
	`reader` text NOT NULL,
	`proposed_json` text NOT NULL,
	`uploaded_by` text NOT NULL,
	`created_at` text NOT NULL
);
