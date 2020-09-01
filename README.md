# POAPBot
Discord bot for POAP drop events

The bot will listen to a nominated Discord channel during a specified time period. Any member who posts in the channel while the event is active will be sent a private message by the bot. The message is customisable, but will typically contain a link
by which they can claim a POAP token. Additionally, the bot will respond publicly with a reaction to the member's message. 

The bot will only respond to the first message posted by a member during an event.

## Activating the bot
The bot needs to be a member of the Discord server (aka _guild_) in which the event is to take place. A guild administrator must grant permission for the bot to operate within the server. Once this is done, the bot can be addressed in public messages in one of the guild's text channels. Members with suitable admin permissions can interact with the bot to set up and monitor events. 

The bot will generally not attend to non-administrative members outside of an event. 

### Adding the bot to a guild.

A guild administrator should follow this link:
https://discord.com/api/oauth2/authorize?client_id=740817735105249341&permissions=519232&scope=bot

It will open the discord.com site in a browser page. Once the user signs in (which may happen automatically if credentials have been cached), they can select the guild in which the bot is to operate, and approve the bot's permissions in that guild. 

The bot will appear as a new member of the guild, and will begin to monitor the guild's channels for interaction requests.

### Bot Commands
Administrators may issue a command to the bot by mentioning it in a text channel, then adding the command in the message. Example:

`@POAPBot !status`

Note that the _mention_ must be to the bot as a _member_, and not to the _role_ (which has the same name). Depending on the Discord client, the bot's _member_ name may be offered alongside its icon in a selection list when beginning to type the bot's name.

The available commands are:
- *!list* Will show the details of any event set up, pending, current, or past, in the guild.
- *!status* Will show the above, and also an indication of the bot's current status.
- *!setup* Will initiate a dialog to set up a POAP event. Use this to add or modify an event.

Note that the command must be issued in one of the guild's text channels, but the bot will respond in a direct message dialog with the requesting user. The bot will only refer to events added in the same guild as that in which the command is issued. This mechanism ensures that there is no confusion with other guilds, and that the user has admin privileges in that particular guild, since both the bot and the user may be a member of multiple guilds. 

The specific admin privilege required to issue bot commands is _Manage Channels_.

### Setting up an event
Some aspects of a POAP distribution event are customisable, specifically:
- the messages issued publicly and privately by the bot during the event.
- the reaction icon
- the start and end times
- a file containing codes to be issued to participants

The bot will collect these parameters in a private dialog in response to the *!setup* command.

Start and end dates should be entered as a date-time string in the UTC +0 time zone. Example:
`2020-08-18 13:00`

When asked for a reaction, if the default is not to be used, enter the name of the emoji surrounded by colons, e.g. `:medal:` The bot will react to this message itself, as a test.

The bot will offer a default value for each parameter. If an event is being modified, the default value will be the event's current value. To select the default value, respond with a `-` (hyphen) character.

### Codes
The *!setup* dialog will request a set of codes. The expected format is a text file containing 1 code per line. 

Codes will be issued to participants during an event in the direct message from the bot. The code will be inserted to replace the placeholder - `{code}` - in the _response message_. 

Codes will be chosen at random from the list when a participant's message is received. As noted above, a user will only receive the response a single time, so they will only receive one code. Codes must be unique. If a duplicate code is included, it will be ignored. 

The bot will report the number of codes available when a file is uploaded. The number of codes reported is the count of unique codes available at that time to the next event for that guild. The same count is reported in the response to a *!status* or *!list* command. The count will reduce as an event proceeds, always reflecting the number of remaining available codes. 

### Data stores
Event data is stored in a PostgreSQL database, and will be preserved indefinitely. Members participating in an event will be tracked in a Redis data store. This enables the bot to avoid responding more than once to a member. The Redis data store is not persistent, and will eventually be cleared. In any case, the store will be cleared at the start of an event. 

Codes are stored in Redis, with a unique set for each guild. The set will be lost in the event that Redis is shut down, and reloaded from file if the bot is shut down and restarted. Therefore, certain combinations of events could either cause codes to be unavailable or cause them to be reused. E.g. restarting the bot after an event has started.
