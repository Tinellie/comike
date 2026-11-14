CREATE TABLE `map_vacancies` (
	`id` varchar(64) NOT NULL,
	`event_id` varchar(32) NOT NULL,
	`comiket` int NOT NULL,
	`weekday` char(1) NOT NULL,
	`hall` varchar(16) NOT NULL,
	`hall_group` varchar(16) NOT NULL,
	`island_code` varchar(32) NOT NULL,
	`booth_number` char(2) NOT NULL,
	`booth_suffix` char(1) NOT NULL,
	`map_booth_id` varchar(128) NOT NULL,
	`checked_at` datetime NOT NULL,
	CONSTRAINT `map_vacancies_id` PRIMARY KEY(`id`),
	CONSTRAINT `map_vacancies_location_idx` UNIQUE(`event_id`,`weekday`,`hall_group`,`island_code`,`booth_number`,`booth_suffix`)
);
--> statement-breakpoint
CREATE INDEX `map_vacancies_event_idx` ON `map_vacancies` (`event_id`);