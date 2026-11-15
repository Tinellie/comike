CREATE TABLE `user_colour_priorities` (
	`user_id` int NOT NULL,
	`colour` char(7) NOT NULL,
	`priority` int NOT NULL,
	CONSTRAINT `user_colour_priorities_user_id_colour_pk` PRIMARY KEY(`user_id`,`colour`)
);
--> statement-breakpoint
ALTER TABLE `user_colour_priorities` ADD CONSTRAINT `user_colour_priorities_user_id_users_internal_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`internal_id`) ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
INSERT INTO `user_colour_priorities` (`user_id`, `colour`, `priority`)
SELECT `palette`.`user_id`, `palette`.`colour`,
       ROW_NUMBER() OVER (PARTITION BY `palette`.`user_id` ORDER BY `palette`.`colour`) - 1
FROM (SELECT DISTINCT `user_id`, `colour` FROM `user_favorites`) AS `palette`;