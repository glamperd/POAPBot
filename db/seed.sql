INSERT INTO events
(server,
channel,
start_date,
end_date,
response_message,
pass,
created_by,
file_url,
is_whitelisted
)
VALUES (
    'brunitob',
    'secret',
    '2020-10-02 01:10:00',
    '2020-10-04 22:10:00',
    'message response {code}',
    'bDNX5e-pguY',
    'brunitob',
    'https://cdn.discordapp.com/attachments/746402543176777798/760230438832308244/testcodes.csv',
    false
);

INSERT INTO events
(server,
channel,
start_date,
end_date,
response_message,
pass,
created_by,
file_url,
is_whitelisted
)
VALUES (
    'brunitob',
    'secret',
    '2020-10-03 01:10:00',
    '2020-10-05 22:10:00',
    'message response {code}',
    'bb3',
    'brunitob',
    'https://cdn.discordapp.com/attachments/746402543176777798/760230438832308244/testcodes.csv',
    false
);


INSERT INTO codes
(
    code,
    event_id,
    username,
    claimed_date,
    created_date
)
VALUES (
    'b99bb3',
    2,
    null,
    null,
   '2020-10-02 00:00'
);

INSERT INTO codes
(
    code,
    event_id,
    username,
    claimed_date,
    created_date
)
VALUES (
    'b77bb3',
    2,
    null,
    null,
   '2020-10-02 00:00'
);


CREATE TABLE events ( ID SERIAL PRIMARY KEY, server VARCHAR ( 50 ) NOT NULL, channel TEXT, start_date timestamp , end_date timestamp, response_message TEXT, pass TEXT UNIQUE, created_by TEXT, file_url TEXT, is_active BOOLEAN DEFAULT TRUE, is_whitelisted BOOLEAN NULL, whitelist_file_url TEXT NULL);


INSERT INTO events
(server,
start_date,
end_date,
response_message,
pass,
file_url,
is_whitelisted,
whitelist_file_url)
VALUES (
    'brunitob server',
    '2020-10-02 01:10:00',
    '2020-10-04 22:10:00',
    'message response {code}',
    'UZaVX8JfR0s',
    'https://cdn.discordapp.com/attachments/746402543176777798/760230438832308244/testcodes.csv',
    false,
    null
);