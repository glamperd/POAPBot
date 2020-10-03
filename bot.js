const Discord = require("discord.js");
const axios = require("axios");
const csv = require("fast-csv");
const pino = require("pino");
const queryHelper = require("./db");
const pgPromise = require("pg-promise");

const db = pgPromise()({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "postgres",
  password: process.env.DB_PASSWORD || "postgres",
  database: process.env.DB_DATABASE || "",
});

const logger = pino({
  prettyPrint: {
    colorize: true, // --colorize
    errorLikeObjectKeys: ["err", "error"], // --errorLikeObjectKeys
    levelFirst: false, // --levelFirst
    messageKey: "msg", // --messageKey
    levelKey: "level", // --levelKey
    timestampKey: "time", // --timestampKey
    translateTime: false, // --translateTime
    ignore: "pid,hostname", // --ignore,
  },
});

const states = {
  LISTEN: "listen",
  SETUP: "setup",
  EVENT: "event",
};

const steps = {
  NONE: "none",
  CHANNEL: "channel",
  START: "start",
  END: "end",
  START_MSG: "start_msg",
  END_MSG: "end_msg",
  RESPONSE: "response",
  REACTION: "reaction",
  PASS: "pass",
  FILE: "file",
};

const defaultStartMessage =
  "The POAP distribution event is now active. Post a message in this channel to earn your POAP token.";
const defaultEndMessage = "The POAP distribution event has ended.";
const defaultResponseMessage =
  "Thanks for participating in the event. Here is a link where you can claim your POAP token: {code} ";
const defaultPass = "-";
const defaultReaction = "🏅";
const welcomenMsg = "Hey!";
const cantDmMsg = "I can't sent you a DM :/";
let onlyWhitelist = false;

var state = {
  state: states.LISTEN,
  expiry: 0,
  user: undefined,
  next: steps.NONE,
  event: {},
};

var guildEvents = new Map();

const client = new Discord.Client();

client.on("ready", () => {
  logger.info("[SETUP] Discord client ready!");

  (async () => {
    const res = await db.query("select count(*) from pg_database");
    logger.info(
      `[SETUP] ${res[0].count > 0 ? "PG client ready!" : "PG NOT READY"}`
    ); // Hello world!

    await loadPendingEvents();
  })();
});

client.on("message", async (message) => {
  if (message.content === "ping") {
    message.reply("pong");
  } else if (!message.author.bot) {
    if (message.channel.type === "dm") {
      logger.info(
        `[MSG] DM ${message.channel.type} - ${message.content} from ${message.author.username}`
      );

      handlePrivateEventMessage(message);

      if (state.state === states.SETUP && state.user.id === message.author.id) {
        logger.info(
          `[ONMSG] state ${state.state} user ${
            state.user ? state.user.id : "-"
          }`
        );
        handleStepAnswer(message);
      }
    } else {
      handlePublicMessage(message);
    }
  }
});

const sendDM = async (user, message) => {
  return new Promise(async (resolve, reject) => {
    const dm = await user.createDM();
    dm.send(message)
      .then((res) => {
        logger.info(`[DM] perfect, sent!`);
        resolve();
      })
      .catch((error) => {
        logger.error(`[DM] error ${error.httpStatus} - ${error.message}`);
        reject();
      });
  });
};

//-------------------------------
// Message handling

const handlePublicMessage = async (message) => {
  logger.info(
    `[PUBMSG] ${message.content} from ${message.author.username} in guild ${message.channel.guild.name} #${message.channel.name}`
  );

  const bot = client.user;

  if (message.mentions.has(bot)) {
    logger.info(`[PUBMSG] ${message.author.username} - Message mentions me`);
    botCommands(message);
  } 
};

const botCommands = async (message) => {
  if (message.member.permissions.has(Discord.Permissions.FLAGS.MANAGE_GUILD)) {
    // Check that user is an admin in this guild
    if (message.content.includes("!setup") && state.state !== states.SETUP) {
      // one at a time
      logger.info(`[BOT] user has permission`);
      // Get any current record for this guild
      // start dialog in PM
      await setupState(message.author, message.channel.guild.name);
    } else if (message.content.includes("!status")) {
      logger.info(`[BOT] status request`);
      // sendDM(message.author, `Current status: ${state.state}`);
      const events = await queryHelper.getGuildEvents(db, message.channel.guild.name); // Don't auto-create
      if (events && events.length > 0) {
        events.forEach(async e => sendDM(message.author, `${await formattedEvent(e)}`))
        reactMessage(message, "🙌");
      }
    } else {
      message.reply(`Commands are: !setup, !status`);
    }
  } else {
    logger.info(`[BOT] user lacks permission, or invalid command`);
    reactMessage(message, "❗");
  }
};

const handleStepAnswer = async (message) => {
  resetExpiry();
  let answer = message.content;
  switch (state.next) {
    case steps.CHANNEL: {
      logger.info(`[STEPS] answer ${state.event.id}`);
      if (answer === "-") answer = state.event.channel;
      if (answer.startsWith("#")) answer = answer.substring(1);
      // Confirm that channel exists
      const chan = await getChannel(state.event.server, answer);
      if (!chan) {
        state.dm.send(
          `I can't find a channel named ${answer}. Try again? ${
            state.event.channel || ""
          }`
        );
      } else {
        state.event.channel = answer;
        state.next = steps.START;
        state.dm.send(
          `Date and time to start? (${state.event.start_time || ""})`
        );
      }
      break;
    }
    case steps.START: {
      if (answer === "-") answer = state.event.start_time;
      state.event.start_time = answer;
      state.next = steps.END;
      state.dm.send(
        `Date and time to end the event? (${state.event.end_time || ""})`
      );
      break;
    }
    case steps.END: {
      if (answer === "-") answer = state.event.end_time;
      state.event.end_time = answer;
      state.next = steps.START_MSG;
      state.dm.send(
        `Message to publish at the start of the event? (${
          state.event.start_message || defaultStartMessage
        })`
      );
      break;
    }
    case steps.START_MSG: {
      if (answer === "-")
        answer = state.event.start_message || defaultStartMessage;
      state.event.start_message = answer;
      state.next = steps.END_MSG;
      state.dm.send(
        `Message to publish to end the event? (${
          state.event.end_message || defaultEndMessage
        })`
      );
      break;
    }
    case steps.END_MSG: {
      if (answer === "-") answer = state.event.end_message || defaultEndMessage;
      state.event.end_message = answer;
      state.next = steps.RESPONSE;
      state.dm.send(
        `Response to send privately to members during the event? (${
          state.event.response_message || defaultResponseMessage
        })`
      );
      break;
    }
    case steps.RESPONSE: {
      if (answer === "-")
        answer = state.event.response_message || defaultResponseMessage;
      state.event.response_message = answer;
      state.next = steps.REACTION;
      state.dm.send(
        `Reaction to public message by channel members during the event? (${
          state.event.reaction || defaultReaction
        })`
      );
      break;
    }
    case steps.REACTION: {
      if (answer === "-") answer = state.event.reaction || defaultReaction;
      state.event.reaction = answer;
      //const emoji = getEmoji(state.event.server, answer);
      logger.info(`[STEPS] reacting with ${answer}`);
      await message.react(answer);
      state.next = steps.PASS;
      state.dm.send(
        `You can add a secret 🔒  pass (like a word, a hash from youtube or a complete link). If you don't need a password just answer with "-"`
      );
      break;
    }
    case steps.PASS: {
      if (answer === "-") answer = defaultPass;
      state.event.pass = answer;
      //const emoji = getEmoji(state.event.server, answer);
      logger.info(`[STEPS] pass to get the POAP ${answer}`);
      state.next = steps.FILE;
      state.dm.send(`Please attach a CSV file containing tokens`);
      break;
    }
    case steps.FILE: {
      if (message.attachments.size <= 0) {
        state.dm.send(`No file attachment found!`);
      } else {
        const ma = message.attachments.first();
        logger.info(`[STEPS] File ${ma.name} ${ma.url} ${ma.id} is attached`);
        state.event.file_url = ma.url;
        let total_count = await readFile(ma.url, state.event.server);
        // Report number of codes added
        state.dm.send(`${total_count} codes added`);
      }
      state.next = steps.NONE;
      state.dm.send(
        `Thank you. That's everything. I'll start the event at the appointed time.`
      );
      clearTimeout(state.expiry);
      await saveEvent(state.event);
      // Set timer for event start
      startEventTimer(state.event);
      clearSetup();
      break;
    }
  }
};

const handlePrivateEventMessage = async (message) => {
  // console.log(message);
  logger.info(`[DM] msg: ${message.content}`);

  // 1) check if pass is correct and return an event
  const event = await queryHelper.getEventFromPass(db, message.content);

  console.log(event.id);

  if (event) {
    const getCode = await queryHelper.checkCodeForEventUsername(
      db,
      event.id,
      message.author.username
    );

    getCode && logger.info(`[SENCODE] Code found: ${getCode.code}`);
    if (getCode && getCode.code) {
      logger.info(`[DM] OK for ${message.author.username}`);

      // replace placeholder in message
      const newMsg = defaultResponseMessage.replace("{code}", getCode.code);

      // Send DM
      replyMessage(message,newMsg)
  
    } else {
      reactMessage(message, "🤔");
      logger.info(`[DM] ${message.author.username} already has a badge`);
    }
  } else {
    // no events
    reactMessage(message, "❌");
  }
};

const replyMessage = async (message, sendMessage) => {
  message
  .reply(sendMessage)
  .catch((error) =>
    logger.error(
      `[DM] error with DM ${error.httpStatus} - ${error.message}`
    )
  );
};

const reactMessage = async (message, reaction) => {
  message
    .react(reaction)
    .catch((error) =>
      logger.error(
        `[EVENTMSG] error with reaction ${error.httpStatus} - ${error.message}`
      )
    );
};


//-------------------------------------------
// Setup

// Initialise the state for a setup dialog
const setupState = async (user, guild) => {
  logger.info(`[SETUP] setupState ${guild}`);
  state.state = states.SETUP;
  state.next = steps.CHANNEL;
  state.event = getGuildEvent(guild); // Will create one if not already
  logger.info(`[SETUP] created or got event ${JSON.stringify(state.event)}`);
  state.dm = await user.createDM();
  state.dm.send(
    `Hi ${user.username}! You want to set me up for an event in ${guild}? I'll ask for the details, one at a time.`
  );
  state.dm.send(`To accept the suggested value, respond with "-"`);
  state.dm.send(
    `First: which channel do you want me to listen to? (${
      state.event.channel || ""
    })`
  );
  state.user = user;
  resetExpiry();
};

const resetExpiry = () => {
  if (state.expiry) {
    clearTimeout(state.expiry);
    state.expiry = setTimeout(() => {
      state.dm.send(
        `Setup expired before answers received. Start again if you wish to complete setup.`
      );
      clearSetup();
    }, 300000);
  }
};

const clearSetup = () => {
  logger.info(`[SETUP] Clearing setup. Event in ${state.event.server} `);
  state.state = states.LISTEN;
  state.dm = undefined;
  state.event = {};
  state.user = undefined;
  state.next = steps.NONE;
};

// ---------------------------------------------------------------------
// Event

const eventIsCurrent = (event, channel) => {
  if (!event) return false;
  if (event.channel !== channel) return false;
  return (
    getMillisecsUntil(event.start_time) < 0 &&
    getMillisecsUntil(event.end_time) > 0
  );
};

const startEventTimer = (event) => {
  // get seconds until event start
  const millisecs = getMillisecsUntil(event.start_time);
  if (millisecs >= 0) {
    logger.info(
      `[TIMER] Event starting at ${event.start_time}, in ${
        millisecs / 1000
      } secs`
    );
    // set timeout. Call startEvent on timeout
    state.eventTimer = setTimeout((ev) => startEvent(ev), millisecs, event);
  }
};

const startEvent = async (event) => {
  logger.info(`[EVENT] started: ${JSON.stringify(event)}`);
  event.user_count = 0;
  // Send the start message to the channel
  sendMessageToChannel(event.server, event.channel, event.start_message);

  // Set reaction emoji
  //event.reaction_emoji = getemoji(event.server, event.reaction);

  // Initialise redis set
  // await clearEventSet(event.server);

  // Set timer for event end
  const millisecs = getMillisecsUntil(event.end_time);
  logger.info(`[EVENT] ending in ${millisecs / 1000} secs`);
  state.endEventTimer = setTimeout((ev) => endEvent(ev), millisecs, event);
};

const getMillisecsUntil = (time) => {
  return Date.parse(time) - new Date();
};

const endEvent = async (event) => {
  logger.info(`[EVENT] ended: ${JSON.stringify(event)}`);
  state.state = states.LISTEN;
  // send the event end message
  sendMessageToChannel(event.server, event.channel, event.end_message);
  updateEventUserCount(event);
};

const formattedEvent = async (event) => {
  if (!event || !event.server) return "";

  let ms = getMillisecsUntil(event.start_date);
  let pending = `Event will start in ${ms / 1000} seconds`;
  if (ms < 0) {
    ms = getMillisecsUntil(event.end_date);
    if (ms < 0) {
      pending = "Event finished";
    } else {
      pending = `Event will end in ${ms / 1000} seconds`;
    }
  }

  const totalCodes = await queryHelper.countTotalCodes(db, event.id)
  const claimedCodes = await queryHelper.countClaimedCodes(db, event.id)

  return `Event in guild: ${event.server}
    Channel: ${event.channel}
    Start: ${event.start_date}
    End: ${event.end_date}
    Event start message: ${defaultStartMessage}
    Event end message: ${defaultEndMessage}
    Response to member messages: ${event.response_message}
    Pass to get the code: ${event.pass}
    Codes url: ${event.file_url}
    Total Codes: ${totalCodes && totalCodes.count}
    Claimed Codes: ${claimedCodes && claimedCodes.count}
    ${pending}`;
};

const getGuildEvent = (guild, autoCreate = true) => {
  if (!guildEvents.has(guild)) {
    if (!autoCreate) return false;
    guildEvents.set(guild, {
      server: guild,
      user_count: 0,
    });
  }
  return guildEvents.get(guild);
};

//-----------------------------------------------
// Discord functions

const sendMessageToChannel = async (guildName, channelName, message) => {
  logger.info(
    `[CHANNELMSG] sendMessageToChannel ${guildName} ${channelName} msg ${message}`
  );
  const channel = getChannel(guildName, channelName);
  if (!channel) {
    return;
  }
  await channel.send(message);
};

const getChannel = (guildName, channelName) => {
  const guild = getGuild(guildName);
  if (!guild) {
    return false;
  }
  const channel = guild.channels.cache.find(
    (chan) => chan.name === channelName
  );
  if (!channel) {
    logger.info(
      `[CHANNELMSG] Channel not found! Guild channels: ${guild.channels.cache.size}`
    );
    return false;
  }
  return channel;
};

const getGuild = (guildName) => {
  const guild = client.guilds.cache.find((guild) => guild.name === guildName);
  if (!guild) {
    logger.info(`[GUILD] not found! Client guilds: ${client.guilds.cache}`);
    return false;
  }
  return guild;
};

const getEmoji = (guildName, emojiName) => {
  // Set reaction emoji
  const guild = getGuild(guildName);
  if (guild) {
    logger.info(`looking for ${emojiName}`);
    let emoji = guild.emojis.cache.find(
      (emoji) => emoji.identifier === emojiName
    );
    if (!emoji) {
      emoji = client.emojis.cache.find(
        (emoji) => emoji.identifier === emojiName
      );
    }
    if (emoji) {
      logger.info(
        `[EMOJI] Found emoji ${emoji.toString()} id ${emoji.identifier}`
      );
    } else {
      logger.info(
        `[EMOJI] ${emojiName} not found. Guild emojis ${JSON.stringify(
          guild.emojis.cache
        )} ${JSON.stringify(client.emojis.cache)} `
      );
    }
  }
  return false;
};

//-------------------------------------------------------------------------------------------------
// DB functions

const checkAndConnectDB = async () => {
  if (!dbConnected) await pgClient.connect();
};

const getEvent = async (guild) => {
  try {
    await checkAndConnectDB();
    const res = await pgClient.query(
      "SELECT * FROM event WHERE server = $1::text",
      [guild]
    );
    logger.info(`[EVENT] retrieved from DB: ${JSON.stringify(res.rows[0])}`);
    //await pgClient.end();
    if (res.rows.length > 0) {
      return res.rows[0];
    } else {
      return {};
    }
  } catch (err) {
    logger.error(`[EVENT] Error while getting event: ${err}`);
    return {};
  }
};

const saveEvent = async (event) => {
  try {
    //await pgClient.connect();
    await checkAndConnectDB();
    let res;
    let oldEvent = await getEvent(event.server);
    if (oldEvent.id) {
      // UPDATE
      logger.info(
        `[PG] Updating... ${oldEvent.id} to ${JSON.stringify(event)}`
      );
      res = await pgClient.query(
        "UPDATE event " +
          "SET channel=$1, start_time=$2, end_time=$3, start_message=$4, end_message=$5, response_message=$6, reaction=$7, pass=$8, user_count=$9, file_url=$10 " +
          "WHERE id=$11",
        [
          event.channel,
          event.start_time,
          event.end_time,
          event.start_message,
          event.end_message,
          event.response_message,
          event.reaction,
          event.pass,
          event.user_count,
          event.file_url,
          oldEvent.id,
        ]
      );
    } else {
      logger.info(`[PG] Inserting... ${uuid} to ${JSON.stringify(event)}`);
      // INSERT
      res = await pgClient.query(
        "INSERT INTO event " +
          "(id, server, channel, start_time, end_time, start_message, end_message, response_message, reaction, pass, user_count, file_url) " +
          "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
        [
          'uuid',
          event.server,
          event.channel,
          event.start_time,
          event.end_time,
          event.start_message,
          event.end_message,
          event.response_message,
          event.reaction,
          event.pass,
          0,
          event.file_url,
        ]
      );
    }
  } catch (err) {
    logger.error(`[PG] Error saving event: ${err}`);
  }
};

const updateEventUserCount = async (event) => {
  try {
    //await pgClient.connect();
    await checkAndConnectDB();
    let res;
    if (event.id) {
      // UPDATE
      logger.info(
        `[PG] Updating user count ... ${event.id} to ${event.user_count}`
      );
      res = await pgClient.query(
        "UPDATE event " + "SET user_count=$1 " + "WHERE id=$2",
        [event.user_count, event.id]
      );
    }
  } catch (err) {
    logger.error(`[PG] Error updating event: ${err}`);
  }
};

const loadPendingEvents = async () => {
  // read all events that will start or end in the future.
  try {
    let res = await queryHelper.getRealtimeActiveEvents(db);
    // console.log(res)
    res &&
      logger.info(`[PG] Active events: ${JSON.stringify(res && res.length)}`);
    if (res && res.length > 0) {
      // start timer for each one.
      res.forEach(async (row) => {
        logger.info(
          `Active event: ${row.id} | ${row.start_date} - ${row.end_date}`
        // startEventTimer(row);

        );
      });
    } else {
      logger.info("[PG] No pending events");
    }
  } catch (err) {
    logger.error(`[PG] Error while getting event: ${err}`);
  }
};



//-------------------------------------------------------------------------------------------
// THIS  MUST  BE  THIS  WAY
client.login(
  process.env.BOT_TOKEN 
);
