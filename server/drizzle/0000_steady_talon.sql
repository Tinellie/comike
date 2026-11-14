CREATE TABLE `booths` (
	`id` varchar(32) NOT NULL,
	`event_id` varchar(32) NOT NULL,
	`comiket` int NOT NULL,
	`circle_name` varchar(255) NOT NULL,
	`author_name` varchar(255),
	`weekday` char(1) NOT NULL,
	`hall` varchar(16) NOT NULL,
	`island_code` varchar(32) NOT NULL,
	`booth_number` char(2) NOT NULL,
	`booth_suffix` varchar(2),
	`genre` varchar(255),
	`genre_code` varchar(16),
	`circle_id` varchar(32) NOT NULL,
	`pixiv_id` varchar(32),
	`twitter_id` varchar(64),
	`images` text NOT NULL,
	`source_url` text NOT NULL,
	`last_crawled_at` datetime NOT NULL,
	CONSTRAINT `booths_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `crawl_jobs` (
	`id` varchar(36) NOT NULL,
	`state` text NOT NULL,
	`updated_at` datetime NOT NULL,
	CONSTRAINT `crawl_jobs_id` PRIMARY KEY(`id`)
);
