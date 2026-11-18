CREATE TABLE `social_image_lists` (
	`provider` varchar(16) NOT NULL,
	`artist_id` varchar(32) NOT NULL,
	`checked_at` datetime(3) NOT NULL,
	`images` json NOT NULL,
	CONSTRAINT `social_image_lists_provider_artist_id_pk` PRIMARY KEY(`provider`,`artist_id`)
);
