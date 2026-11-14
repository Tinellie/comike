CREATE TABLE `circle_list_cache` (
	`id` varchar(32) NOT NULL,
	`state` longtext NOT NULL,
	CONSTRAINT `circle_list_cache_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `booths` MODIFY COLUMN `circle_id` varchar(32);