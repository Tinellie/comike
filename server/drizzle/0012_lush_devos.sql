CREATE TABLE `images_pixiv` (
	`image_id` varchar(32) NOT NULL,
	`pixiv_id` varchar(32) NOT NULL,
	CONSTRAINT `images_pixiv_image_id` PRIMARY KEY(`image_id`)
);
--> statement-breakpoint
ALTER TABLE `booths` ADD `pixiv_images_updated_at` datetime;--> statement-breakpoint
CREATE INDEX `images_pixiv_user_idx` ON `images_pixiv` (`pixiv_id`);