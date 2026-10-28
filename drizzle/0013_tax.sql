ALTER TABLE `vendors` ADD `tax_type` text;
--> statement-breakpoint
ALTER TABLE `vendors` ADD `tax_form` text;
--> statement-breakpoint
ALTER TABLE `vendors` ADD `tax_form_at` text;
--> statement-breakpoint
ALTER TABLE `vendors` ADD `withholding_bps` integer;
--> statement-breakpoint
ALTER TABLE `obligations` ADD `withheld_minor` integer;
--> statement-breakpoint
ALTER TABLE `obligations` ADD `withholding_note` text;
