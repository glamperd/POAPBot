CREATE TABLE events ( ID SERIAL PRIMARY KEY, server VARCHAR ( 50 ) NOT NULL, channel TEXT, start_date timestamp , end_date timestamp, response_message TEXT, pass TEXT UNIQUE, created_by TEXT, file_url TEXT, is_active BOOLEAN DEFAULT TRUE, is_whitelisted BOOLEAN NULL, whitelist_file_url TEXT NULL);
CREATE TABLE codes ( ID SERIAL PRIMARY KEY, code VARCHAR ( 50 ) UNIQUE NOT NULL, event_id INTEGER, username TEXT NULL, is_active BOOLEAN DEFAULT TRUE, claimed_date timestamp NULL, created_date timestamp);
-- TODO: contraint between events and codes
