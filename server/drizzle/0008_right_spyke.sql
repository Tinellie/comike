CREATE TABLE `map_genre_regions` (
	`event_id` varchar(32) NOT NULL,
	`weekday` char(1) NOT NULL,
	`hall_group` varchar(16) NOT NULL,
	`genre_key` varchar(300) NOT NULL,
	`rectangles` json NOT NULL,
	CONSTRAINT `map_genre_regions_event_id_weekday_hall_group_genre_key_pk` PRIMARY KEY(`event_id`,`weekday`,`hall_group`,`genre_key`)
);
--> statement-breakpoint
CREATE TABLE `map_genres` (
	`event_id` varchar(32) NOT NULL,
	`weekday` char(1) NOT NULL,
	`genre_key` varchar(300) NOT NULL,
	`genre` varchar(255),
	`genre_code` varchar(16),
	`color` char(7) NOT NULL,
	`circle_count` int NOT NULL,
	`checked_at` datetime NOT NULL,
	CONSTRAINT `map_genres_event_id_weekday_genre_key_pk` PRIMARY KEY(`event_id`,`weekday`,`genre_key`)
);
--> statement-breakpoint
CREATE TABLE `map_vacancy_regions` (
	`event_id` varchar(32) NOT NULL,
	`weekday` char(1) NOT NULL,
	`hall_group` varchar(16) NOT NULL,
	`rectangles` json NOT NULL,
	`checked_at` datetime NOT NULL,
	CONSTRAINT `map_vacancy_regions_event_id_weekday_hall_group_pk` PRIMARY KEY(`event_id`,`weekday`,`hall_group`)
);
