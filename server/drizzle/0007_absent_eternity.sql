ALTER TABLE `map_vacancies`
  DROP INDEX `map_vacancies_location_idx`,
  DROP PRIMARY KEY,
  ADD PRIMARY KEY(`event_id`,`weekday`,`hall_group`,`island_code`,`booth_number`,`booth_suffix`),
  DROP COLUMN `id`;