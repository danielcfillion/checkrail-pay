ALTER TABLE `obligations` ADD `invoice_date` text;
--> statement-breakpoint
ALTER TABLE `vendors` ADD `payment_terms_days` integer;
--> statement-breakpoint
ALTER TABLE `vendors` ADD `phone` text;
--> statement-breakpoint
ALTER TABLE `vendors` ADD `tax_id` text;
