const Discord = require('discord.js');
const { Client } = require('pg');
const redis = require('redis');
const { promisify } = require('util');
const axios = require('axios');

const states = {
    LISTEN: 'listen',
    SETUP: 'setup',
    EVENT: 'event',
};
const steps = {
    NONE: 'none',
    CHANNEL: 'channel',
    START: 'start',
    END: 'end',
    START_MSG: 'start_msg',
    END_MSG: 'end_msg',
    RESPONSE: 'response',
    REACTION: 'reaction',
    FILE: 'file',
};

const defaultStartMessage = 'The POAP distribution event is now active. Post a message in this channel to earn your POAP token.';
const defaultEndMessage = 'The POAP distribution event has ended.';
const defaultResponseMessage = 'Here is a link where you can claim your POAP token: http://poap.xyz/{code} Thanks for participating in the event. ';
const defaultReaction = ':medal:';
const codeSet = '#codes';

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

client.on('ready', () => {
    console.log('Discord client ready!');

    (async () => {
        await pgClient.connect();
        dbConnected = true;
        const res = await pgClient.query('SELECT $1::text as message', ['DB ready'])
        console.log(res.rows[0].message) // Hello world!
        //await pgClient.end()

        loadPendingEvents();
      })()      
});

client.on('message', async message => {
    if (message.content === 'ping') {
       message.reply('pong');
    } else if (!message.author.bot) {
        if (message.channel.type === 'dm') {
            console.log(`DM Message ${message.content} from ${message.author.username} in ${message.channel.type}`);
            console.log(`state ${state.state} user ${state.user ? state.user.id : '-'}`);
            if (state.state === states.SETUP && 
                state.user.id === message.author.id) {
                handleStepAnswer(message);
            }
        } else {
            handlePublicMessage(message);
        }
    }
});

const sendDM = async (user, message) => {
    const dm = await user.createDM();
    dm.send(message);
}

//-------------------------------
// Message handling

const handlePublicMessage = async (message) => {
    console.log(`Message ${message.content} from ${message.author.username} in guild ${message.channel.guild.name} #${message.channel.name}`);
    const bot = client.user;
    //console.log(`bot user ID ${bot.id} ${bot.username}`);

    const event = getGuildEvent(message.channel.guild.name);

    if (message.mentions.has(bot)) {

        console.log(`Message mentions me`);
        botCommands(message);

    } else if (eventIsCurrent(event, message.channel.name)) {

        // In-event message. Respond with reaction and DM
        handleEventMessage(message);

    }

}

const botCommands = async (message) => {
    if (message.member.permissions.has(Discord.Permissions.FLAGS.MANAGE_GUILD)) {// Check that user is an admin in this guild                     
        if (message.content.includes('!setup') &&
            state.state !== states.SETUP) {// one at a time

            console.log(`user has permission`)
            // Get any current record for this guild
            //state.event = getEvent(message.guild.name);
            // start dialog in PM
            await setupState(message.author, message.channel.guild.name);

        } else if (message.content.includes('!list')) {

            console.log(`list event `);
            const event = getGuildEvent(message.channel.guild.name, false); // Don't auto-create
            if (event && event.server) {
                console.log(`event ${JSON.stringify(event)}`);
                sendDM(message.author, await formattedEvent(event));
            } else {
                console.log(`No current event`);
                sendDM(message.author, `No event is currently set up for ${message.channel.guild.name}. Use the !setup command to set one up.`);
            }

        } else if (message.content.includes('!status')) {

            console.log(`status request`);
            sendDM(message.author, `Current status: ${state.state}`);
            const event = getGuildEvent(message.channel.guild.name, false); // Don't auto-create
            if (event && event.server) {
                sendDM(message.author, `Event: ${await formattedEvent(event)}`);
            }

        } else {
            message.reply(`Commands are: !setup, !list, !status`);
        }
    } else {
        console.log(`user lacks permission, or invalid command`);
        message.react('❗');
    }

}

const handleStepAnswer = async (message) => {
    resetExpiry();
    let answer = message.content;
    switch (state.next) {
        case steps.CHANNEL: {
            console.log(`step answer ${state.event.id}`);
            if (answer === '-') answer = state.event.channel;
            if (answer.startsWith('#')) answer = answer.substring(1);
            // Confirm that channel exists
            const chan = await getChannel(state.event.server, answer);
            if (!chan) {
                state.dm.send(`I can't find a channel named ${answer}. Try again? ${state.event.channel || ''}`);
            } else {
                state.event.channel = answer;
                state.next = steps.START;
                state.dm.send(`Date and time to start? ${state.event.start_time || ''}`);
            }
            break;
        }
        case steps.START: {
            if (answer === '-') answer = state.event.start_time;
            state.event.start_time = answer;
            state.next = steps.END;
            state.dm.send(`Date and time to end the event? (${state.event.end_time || ''})`);
            break;
        }
        case steps.END: {
            if (answer === '-') answer = state.event.end_time;
            state.event.end_time = answer;
            state.next = steps.START_MSG;
            state.dm.send(`Message to publish at the start of the event? (${state.event.start_message || defaultStartMessage})`);
            break;
        }
        case steps.START_MSG: {
            if (answer === '-') answer = state.event.start_message || defaultStartMessage;
            state.event.start_message = answer;
            state.next = steps.END_MSG;
            state.dm.send(`Message to publish to end the event? (${state.event.end_message || defaultEndMessage })`);
            break;
        }
        case steps.END_MSG: {
            if (answer === '-') answer = state.event.end_message || defaultEndMessage;
            state.event.end_message = answer;
            state.next = steps.RESPONSE;
            state.dm.send(`Response to send privately to members during the event? (${state.event.response_message || defaultResponseMessage})`);
            break;
        }
        case steps.RESPONSE: {
            if (answer === '-') answer = state.event.response_message || defaultResponseMessage;
            state.event.response_message = answer;
            state.next = steps.REACTION;
            state.dm.send(`Reaction to public message by channel members during the event? (${state.event.reaction || defaultReaction})`);
            break;
        }
        case steps.REACTION: {
            if (answer === '-') answer = state.event.reaction || defaultReaction;
            state.event.reaction = answer;
            state.next = steps.FILE;
            state.dm.send(`Please attach a CSV file containing tokens`);
            break;
        }
        case steps.FILE: {
            if (message.attachments.size <= 0) {
                state.dm.send(`No file attachment found!`);
            } else {
                const ma = message.attachments.first();
                console.log(`File ${ma.name} ${ma.url} ${ma.id} is attached`);
                state.event.file_url = ma.url;
                await readFile(ma.url, state.event.server);
                // Report number of codes added
                state.dm.send(`${await setSize(state.event.server + codeSet)} codes added`);
            }
            state.next = steps.NONE;
            state.dm.send(`Thank you. That's everything. I'll start the event at the appointed time.`);
            clearTimeout(state.expiry);
            await saveEvent(state.event);
            // Set timer for event start
            startEventTimer(state.event);
            clearSetup();
            break;
        }
    }
}

const handleEventMessage = async (message) => {
    let event = getGuildEvent(message.channel.guild.name);

    // Check whether already responded (Redis)
    const check = await addToSet(event.server, message.author.username);
    console.log(`Check redis: ${check}`);
    if (check) {
        // Get code
        const code = await popFromSet(event.server + codeSet);
        console.log(`Code found: ${code}`);

        // replace placeholder in message
        const newMsg = event.response_message.replace('{code}', code);

        // Send DM
        sendDM(message.author, newMsg);
        // Add reaction
        message.react(event.reaction_emoji);

        event.user_count ++;

        // TODO ?? Add to used codes map ??

    }
}

//-------------------------------------------
// Setup 

// Initialise the state for a setup dialog
const setupState = async (user, guild) => {
    console.log(`setupState ${guild}`);
    state.state = states.SETUP;
    state.next = steps.CHANNEL;
    state.event = getGuildEvent(guild); // Will create one if not already 
    console.log(`created or got event ${JSON.stringify(state.event)}`);
    state.dm = await user.createDM();
    state.dm.send(`Hi ${user.username}! You want to set me up for an event in ${guild}? I'll ask for the details, one at a time.`);
    state.dm.send(`To accept the suggested value, respond with "-"`);
    state.dm.send(`First: which channel do you want me to listen to? (${state.event.channel || ''})`);
    state.user = user;
    //if (!state.event.id) { state.event.server = guild; }
    resetExpiry();
}

const resetExpiry = () => {
    if (state.expiry) {
        clearTimeout(state.expiry);
        state.expiry = setTimeout( () => {
            state.dm.send(`Setup expired before answers received. Start again if you wish to complete setup.`);
            clearSetup();
        }, 300000 );
    }
}

const clearSetup = () => {
    console.log(`Clearing setup. Event in ${state.event.server} `);
    state.state = states.LISTEN;
    state.dm = undefined;
    state.event = {};
    state.user = undefined;
    state.next = steps.NONE;
}

// ---------------------------------------------------------------------
// Event

const eventIsCurrent = (event, channel) => {
    if (!event) return false;
    if (event.channel !== channel) return false;
    return (getMillisecsUntil(event.start_time)<0 && getMillisecsUntil(event.end_time)>0);
}

const startEventTimer = (event) => {
    // get seconds until event start
    const millisecs = getMillisecsUntil(event.start_time);
    if (millisecs >= 0) {
        console.log(`Event starting at ${event.start_time}, in ${millisecs/1000} secs`);
        // set timeout. Call startEvent on timeout
        state.eventTimer = setTimeout( ev => startEvent(ev), millisecs, event);
    }
}

const startEvent = async (event) => {
    console.log(`event started: ${JSON.stringify(event)}`);
    event.user_count = 0;
    // Send the start message to the channel
    sendMessageToChannel(event.server, event.channel, event.start_message);

    // Set reaction emoji
    const guild = getGuild(event.server);
    if (guild) {
        event.reaction_emoji = guild.emojis.cache.find(emoji => emoji.name === event.reaction);
    }

    // Initialise redis set
    await clearEventSet(event.server);

    // Set timer for event end
    const millisecs = getMillisecsUntil(event.end_time);
    console.log(`Event ending in ${millisecs/1000} secs`);
    state.endEventTimer = setTimeout( ev => endEvent(ev), millisecs, event);
}

const getMillisecsUntil = (time) => {
    return Date.parse(time) - new Date();
}

const endEvent = async (event) => {
    console.log(`event ended: ${JSON.stringify(event)}`);
    state.state = states.LISTEN;
    // send the event end message
    sendMessageToChannel(event.server, event.channel, event.end_message);
    updateEventUserCount(event);
}

const formattedEvent = async (event) => {
    if (!event || !event.server) return '';

    let ms = getMillisecsUntil(event.start_time);
    let pending = `Event will start in ${ms/1000} seconds`;
    if (ms < 0) {
        ms = getMillisecsUntil(event.end_time);
        if (ms < 0) {
            pending = 'Event finished';
        } else {    
            pending = `Event will end in ${ms/1000} seconds`;
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
    Data url: ${event.file_url}
    Codes available: ${await setSize(event.server + codeSet)}
    Members awarded: ${event.user_count}
    ${pending}`;

}

const getGuildEvent = (guild, autoCreate = true) => {
    if (!guildEvents.has(guild)) {
        if (!autoCreate) return false;
        guildEvents.set(guild, { 
            server: guild, 
            user_count: 0 
        });
    }
    return guildEvents.get(guild);
}

//-----------------------------------------------
// Discord functions

const sendMessageToChannel = async (guildName, channelName, message) => {
    console.log(`sendMessageToChannel ${guildName} ${channelName} msg ${message}`);
    const channel = getChannel(guildName, channelName);
    if (!channel) {
        return;
    }
    await channel.send(message);
}

const getChannel = (guildName, channelName) => {
    const guild = getGuild(guildName);
    if (!guild) {
        return false;
    }
    const channel = guild.channels.cache.find(chan => (chan.name === channelName));
    if (!channel) {
        console.log(`Channel not found! Guild channels: ${guild.channels.cache.size}`);
        return false;
    }
    return channel;
}

const getGuild = (guildName) => {
    const guild = client.guilds.cache.find(guild => (guild.name === guildName));
    if (!guild) {
        console.log(`Guild not found! Client guilds: ${client.guilds.cache}`);
        return false;
    }
    return guild;
}

const readFile = async (url, guild) => {
    try {
        const res = await axios.get(url);
        console.log(`File data: ${res.data}`);
        const setName = guild + codeSet;
        res.data.split('\n').forEach((val) => {
            console.log(`code ${val}`);
            // Add to redis set
            if (val.length > 0) {
                addToSet(setName, val);
            }
        });
    } catch (err) {
        console.log(`Error reading file: ${err}`);
    }
}

//-------------------------------------------------------------------------------------------------
// DB functions
pgClient.on('end', () => {
    dbConnected = false;
})

const checkAndConnectDB = async () => {
    if (!dbConnected) await pgClient.connect();
}

const getEvent = async (guild) => {
    try {
        await checkAndConnectDB();
        const res = await pgClient.query('SELECT * FROM event WHERE server = $1::text', [guild]);
        console.log(`Event retrieved from DB: ${JSON.stringify(res.rows[0])}`);
        //await pgClient.end();
        if (res.rows.length > 0) {
            return res.rows[0];
        } else {
            return {};
        }
    } catch (err) {
        console.log(`Error while getting event: ${err}`);
        return {};
    }
}

const saveEvent = async (event) => {
    try {
        //await pgClient.connect();
        await checkAndConnectDB();
        let res;
        let oldEvent = await getEvent(event.server);
        if (oldEvent.id) {
            // UPDATE
            console.log(`Updating... ${oldEvent.id} to ${JSON.stringify(event)}`);
            res = await pgClient.query('UPDATE event ' + 
                'SET channel=$1, start_time=$2, end_time=$3, start_message=$4, end_message=$5, response_message=$6, reaction=$7, user_count=$8, file_url=$9 ' + 
                'WHERE id=$10',
            [event.channel, event.start_time, event.end_time, 
                event.start_message, event.end_message, 
                event.response_message, event.reaction, 
                event.user_count, event.file_url, oldEvent.id]);
        } else {
            const uuid = uuidv4();
            console.log(`Inserting... ${uuid} to ${JSON.stringify(event)}`);
            // INSERT
            res = await pgClient.query('INSERT INTO event ' + 
                '(id, server, channel, start_time, end_time, start_message, end_message, response_message, reaction, user_count, file_url) ' + 
                'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, $10)',
            [uuid, event.server, event.channel, event.start_time, event.end_time, event.start_message, event.end_message, event.response_message, event.reaction, event.file_url]);
        }
    } catch (err) {
        console.log(`Error saving event: ${err}`);
    } 
}

const updateEventUserCount = async (event) => {
    try {
        //await pgClient.connect();
        await checkAndConnectDB();
        let res;
        if (event.id) {
            // UPDATE
            console.log(`Updating user count ... ${event.id} to ${event.user_count}`);
            res = await pgClient.query('UPDATE event ' + 
                'SET user_count=$1 ' + 
                'WHERE id=$2',
            [event.user_count, event.id]);
        }
    } catch (err) {
        console.log(`Error saving event: ${err}`);
    }
}

const loadPendingEvents = async () => {
    // read all events that will start or end in the future.
    try {
        await checkAndConnectDB();
        const res = await pgClient.query('SELECT * FROM event WHERE end_time >= $1::date', [new Date()]);
        console.log(`Future events loaded: ${JSON.stringify(res.rows)}`);
        if (res.rows.length > 0) {
            // start timer for each one. 
            res.rows.forEach(row => {
                console.log(`Adding to map: ${row.server}`);
                guildEvents.set(row.server, row);
                if (row.file_url) {
                    readFile(row.file_url, row.server);
                }
                startEventTimer(row);
            });
        } else {
            console.log('No pending events');
        }
    } catch (err) {
        console.log(`Error while getting event: ${err}`);
    }
}

function uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
}

//-------------------------------------------------------------------------------------------
// Redis

const saddAsync = promisify(redisClient.sadd).bind(redisClient);
//const sismemberAsync = promisify(redisClient.sismember).bind(redisClient);
const delAsync = promisify(redisClient.del).bind(redisClient);
const scardAsync = promisify(redisClient.scard).bind(redisClient);
const spopAsync = promisify(redisClient.spop).bind(redisClient);

redisClient.on('connect', () => {
    console.log(`Redis client connected`);
});

const clearEventSet = async (guild) => {
    // remove any members from the guild's set. Called prior to an event's start.
    const rem = await delAsync(guild, (err, result) => {
        console.log(`Set deleted: ${guild} - ${err} -  ${result} keys removed`);
        return result;
    });
    console.log(`Set removed ${rem}`);
}

// const isSetMember = async (guild, member) => {
//     // returns true if a member (discord user) is already in the event's set 
//     let count = 0;
//     await sismemberAsync(guild, member, (err, result) => {
//         if (err) return 0;
//         count = result;
//     });
//     return count;
// }

const addToSet = async (guild, member) => {
    // adds a user to an event's set
    // returns 0 if already in the set, 1 otherwise
    let c = await saddAsync(guild, member, (err, result) => {
        console.log(`Redis SADD -  error ${err} result ${result}`);
        if (err) return 0;
        return result;
    });
    console.log(`addToSet ${c}`);
    return c;
} 

const setSize = async (setName) => {
    return scardAsync(setName);
}

const popFromSet = async (setName) => {
    return spopAsync(setName);
}

//-------------------------------------------------------------------------------------------

// THIS  MUST  BE  THIS  WAY
client.login(process.env.BOT_TOKEN);

