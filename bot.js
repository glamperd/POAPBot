const Discord = require("discord.js");
const { Client } = require("pg");
const redis = require("redis");
const { promisify } = require("util");
const axios = require("axios");
const csv = require("fast-csv");
const pino = require("pino");

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
const codeSet = "#codes";
const welcomenMsg = "Hey!";
const cantDmMsg = "I can't sent you a DM :/";

var state = {
  state: states.LISTEN,
  expiry: 0,
  user: undefined,
  next: steps.NONE,
  event: {},
};

var guildEvents = new Map();

const client = new Discord.Client();

const pgClient = new Client({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_DATABASE,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});
var dbConnected = false;

const redisClient = redis.createClient(process.env.REDIS_URL);

client.on("ready", () => {
  logger.info("[SETUP] Discord client ready!");

  (async () => {
    await pgClient.connect();
    dbConnected = true;
    const res = await pgClient.query("SELECT $1::text as message", [
      "DB ready",
    ]);
    logger.info(`[SETUP] ${res.rows[0].message}`); // Hello world!
    //await pgClient.end()
    loadPendingEvents();
  })();
});

client.on("message", async (message) => {
  if (message.content === "ping") {
    message.reply("pong");
  } else if (!message.author.bot) {
    if (message.channel.type === "dm") {
      logger.info(
        `[ONMSG] ${message.channel.type} - ${message.content} from ${message.author.username}`
      );
      logger.info(
        `[ONMSG] state ${state.state} user ${state.user ? state.user.id : "-"}`
      );
      if (state.state === states.SETUP && state.user.id === message.author.id) {
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
  const event = getGuildEvent(message.channel.guild.name);

  if (message.mentions.has(bot)) {
    logger.info(`[PUBMSG] ${message.author.username} - Message mentions me`);
    botCommands(message);
  } else if (eventIsCurrent(event, message.channel.name)) {
    // In-event message. Respond with reaction and DM
    handleEventMessage(message);
  }
};

const botCommands = async (message) => {
  if (message.member.permissions.has(Discord.Permissions.FLAGS.MANAGE_GUILD)) {
    // Check that user is an admin in this guild
    if (message.content.includes("!setup") && state.state !== states.SETUP) {
      // one at a time
      logger.info(`[BOT] user has permission`);
      // Get any current record for this guild
      //state.event = getEvent(message.guild.name);
      // start dialog in PM
      await setupState(message.author, message.channel.guild.name);
    } else if (message.content.includes("!list")) {
      logger.info(`[BOT] list event `);
      const event = getGuildEvent(message.channel.guild.name, false); // Don't auto-create
      if (event && event.server) {
        logger.info(`[BOT] event ${JSON.stringify(event)}`);
        sendDM(message.author, await formattedEvent(event));
      } else {
        logger.info(`[BOT] No current event`);
        sendDM(
          message.author,
          `No event is currently set up for ${message.channel.guild.name}. Use the !setup command to set one up.`
        );
      }
    } else if (message.content.includes("!status")) {
      logger.info(`[BOT] status request`);
      sendDM(message.author, `Current status: ${state.state}`);
      const event = getGuildEvent(message.channel.guild.name, false); // Don't auto-create
      if (event && event.server) {
        sendDM(message.author, `Event: ${await formattedEvent(event)}`);
      }
    } else {
      message.reply(`Commands are: !setup, !list, !status`);
    }
  } else {
    logger.info(`[BOT] user lacks permission, or invalid command`);
    message.react("❗");
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

const handleEventMessage = async (message) => {
  // get event
  let event = getGuildEvent(message.channel.guild.name);
  logger.info(`[EVENTMSG] is ${event.pass} in msg: ${message.content}`);

  const exist = await memberExist(event.server, message.author.username);

  // check return 1 if new check return 0 if already added
  logger.info(
    `[EVENTMSG] Check redis: ${exist} | ${message.author.username} ${
      exist == 0 ? "new username" : "not new"
    }`
  );
  // 1) check if the user already exist

  if (exist == 0) {
    // 2) pass?
    if (
      event.pass == "-" ||
      message.content.toLowerCase().includes(event.pass.toLowerCase())
    ) {
      logger.info(`[EVENTMSG] sending welcome to ${message.author.username}`);

      // 3) Say welcome!, the user has DMs open?
      sendDM(message.author, welcomenMsg)
        .then(() => {
          logger.info(`[EVENTMSG] Lets do this ${message.author.username}`);
          // 4) send code
          sendCodeToUser(event, message);
        })
        .catch(() => {
          logger.info(
            `[EVENTMSG] we can't talk with ${message.author.username}`
          );
          message.reply(cantDmMsg);
        });
      // TODO ?? Add to used codes map ??
    } else {
      logger.info(`[EVENTMSG] sorry wrong pass: ${message.content}`);
      // now react !
      message
        .react("❌")
        .catch((error) =>
          logger.error(
            `[EVENTMSG] error with reaction ${error.httpStatus} - ${error.message}`
          )
        );
    }
  } else {
    logger.info(
      `[EVENTMSG] we can't continue talking with ${message.author.username}`
    );
  }
  // Check whether already responded (Redis)
};

const sendCodeToUser = async (event, message) => {
  const check = await addToSet(event.server, message.author.username);
  if (check) {
    const code = await popFromSet(event.server + codeSet);
    logger.info(`[SENCODE] Code found: ${code}`);
    // replace placeholder in message
    const newMsg = event.response_message.replace("{code}", code);
    // Send DM
    sendDM(message.author, newMsg);
    // Add reaction
    await message.react(event.reaction);
    event.user_count++;
    logUserAndCode(event, message.author.username, code);
  } else {
    logger.info(`[SENDCODE] ${message.author.username} already has a badge`);
  }
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
  await clearEventSet(event.server);

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

  let ms = getMillisecsUntil(event.start_time);
  let pending = `Event will start in ${ms / 1000} seconds`;
  if (ms < 0) {
    ms = getMillisecsUntil(event.end_time);
    if (ms < 0) {
      pending = "Event finished";
    } else {
      pending = `Event will end in ${ms / 1000} seconds`;
    }
  }

  return `Event in guild: ${event.server}
    Channel: ${event.channel}
    Start: ${event.start_time}
    End: ${event.end_time}
    Event start message: ${event.start_message}
    Event end message: ${event.end_message}
    Response to member messages: ${event.response_message}
    Reaction to awarded messages: ${event.reaction}
    Pass to get the code: ${event.pass}
    Data url: ${event.file_url}
    Codes available: ${await setSize(event.server + codeSet)}
    Members awarded: ${event.user_count}
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

const readFile = async (url, guild) => {
  return new Promise(async (resolve, reject) => {
    try {
      const res = await axios.get(url);
      const setName = guild + codeSet;
      logger.info(`[CODES] setName: ${setName}`);
      let count = 0;
      csv
        .parseString(res.data, { headers: false })
        .on("data", function (code) {
          if (code.length) {
            logger.info(`-> code added: ${code}`);
            count += 1;
            addToSet(setName, code);
          }
        })
        .on("end", function () {
          logger.info(`[CODES] total codes ${count}`);
          resolve(count);
        })
        .on("error", (error) => logger.error(error));
    } catch (err) {
      logger.error(`[CODES] Error reading file: ${err}`);
    }
  });
};

//-------------------------------------------------------------------------------------------------
// DB functions
pgClient.on("end", () => {
  dbConnected = false;
});

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
      const uuid = uuidv4();
      logger.info(`[PG] Inserting... ${uuid} to ${JSON.stringify(event)}`);
      // INSERT
      res = await pgClient.query(
        "INSERT INTO event " +
          "(id, server, channel, start_time, end_time, start_message, end_message, response_message, reaction, pass, user_count, file_url) " +
          "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
        [
          uuid,
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

const logUserAndCode = async (event, username, code) => {
  try {
    let date = new Date();
    let res;
    await checkAndConnectDB();
    // ADD LOG
    logger.info(
      `[PG] adding log to ${username} to ${event.server}|${event.channel}`
    );
    res = await pgClient.query(
      "INSERT INTO logs " +
        "(server, channel, username, code, date)" +
        "VALUES ($1, $2, $3, $4, $5)",
      [event.server, event.channel, username, code, date]
    );
  } catch (err) {
    logger.error(`[PG] Error logging code: ${err}`);
  }
};

const loadPendingEvents = async () => {
  // read all events that will start or end in the future.
  try {
    await checkAndConnectDB();
    const res = await pgClient.query(
      "SELECT * FROM event WHERE end_time >= $1::date",
      [new Date()]
    );
    logger.info(`[PG] Future events loaded: ${JSON.stringify(res.rows)}`);
    if (res.rows.length > 0) {
      // start timer for each one.
      res.rows.forEach(async (row) => {
        logger.info(`Adding to map: ${row.server}`);
        let size = await setSize(row.server + codeSet);
        size && logger.error(`CAUTION! FOUND OLD EVENTS FOR: ${row.server}`);
        guildEvents.set(row.server, row);
        // if (row.file_url) {
        //   readFile(row.file_url, row.server);
        // }
        startEventTimer(row);
      });
    } else {
      logger.info("[PG] No pending events");
    }
  } catch (err) {
    logger.error(`[PG] Error while getting event: ${err}`);
  }
};

function uuidv4() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    var r = (Math.random() * 16) | 0,
      v = c == "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

//-------------------------------------------------------------------------------------------
// Redis

const saddAsync = promisify(redisClient.sadd).bind(redisClient);
const sismemberAsync = promisify(redisClient.sismember).bind(redisClient);
//const sismemberAsync = promisify(redisClient.sismember).bind(redisClient);
const delAsync = promisify(redisClient.del).bind(redisClient);
const scardAsync = promisify(redisClient.scard).bind(redisClient);
const spopAsync = promisify(redisClient.spop).bind(redisClient);

redisClient.on("connect", () => {
  logger.info(`[SETUP] Redis client connected`);
});

const clearEventSet = async (guild) => {
  // remove any members from the guild's set. Called prior to an event's start.
  const rem = await delAsync(guild, (err, result) => {
    logger.info(`Set deleted: ${guild} - ${err} -  ${result} keys removed`);
    return result;
  });
  logger.info(`Set removed ${rem}`);
};

const memberExist = async (guild, member) => {
  // adds a user to an event's set
  // returns 0 if already in the set, 1 otherwise
  let c = await sismemberAsync(guild, member);
  logger.info(`[REDDIS] sismemberAsync ${member} => ${c}`);
  return c;
};

const addToSet = async (guild, member) => {
  // adds a user to an event's set
  // returns 0 if already in the set, 1 otherwise
  let c = await saddAsync(guild, member);
  logger.info(`[REDDIS] addToSet ${member} => ${c}`);
  return c;
};

const setSize = async (setName) => {
  return scardAsync(setName);
};

const popFromSet = async (setName) => {
  return spopAsync(setName);
};

//-------------------------------------------------------------------------------------------
// THIS  MUST  BE  THIS  WAY
client.login(process.env.BOT_TOKEN);
