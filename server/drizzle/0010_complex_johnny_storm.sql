CREATE TABLE `user_favorites` (
	`user_id` int NOT NULL,
	`booth_id` varchar(32) NOT NULL,
	`colour` char(7) NOT NULL,
	`memo` text NOT NULL,
	CONSTRAINT `user_favorites_user_id_booth_id_pk` PRIMARY KEY(`user_id`,`booth_id`)
);
--> statement-breakpoint
ALTER TABLE `users` ADD `internal_id` int AUTO_INCREMENT NOT NULL, ADD CONSTRAINT `users_internal_id_unique` UNIQUE(`internal_id`);--> statement-breakpoint
ALTER TABLE `user_favorites` ADD CONSTRAINT `user_favorites_user_id_users_internal_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`internal_id`) ON DELETE cascade ON UPDATE no action;