ALTER TABLE `booths` ADD `circle_name_reading` varchar(1024);--> statement-breakpoint
CREATE INDEX `booths_event_id_idx` ON `booths` (`event_id`);