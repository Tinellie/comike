ALTER TABLE `images_twitter` ADD `tweet_id` varchar(32);--> statement-breakpoint
ALTER TABLE `images_twitter` ADD `tweet_created_at` datetime(3);--> statement-breakpoint
ALTER TABLE `images_twitter` ADD `media_index` int;--> statement-breakpoint
UPDATE `booths` AS b
INNER JOIN `images_twitter` AS i ON i.`twitter_number_id` = b.`twitter_number_id`
SET b.`twitter_images_updated_at` = NULL
WHERE i.`tweet_created_at` IS NULL;