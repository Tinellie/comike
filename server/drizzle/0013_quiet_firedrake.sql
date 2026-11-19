CREATE TABLE `images_twitter` (
	`image_id` varchar(32) NOT NULL,
	`twitter_number_id` varchar(32) NOT NULL,
	CONSTRAINT `images_twitter_image_id` PRIMARY KEY(`image_id`)
);
--> statement-breakpoint
ALTER TABLE `booths` ADD `twitter_images_updated_at` datetime;--> statement-breakpoint
ALTER TABLE `booths` ADD `twitter_number_id` varchar(32);--> statement-breakpoint
CREATE INDEX `images_twitter_user_idx` ON `images_twitter` (`twitter_number_id`);