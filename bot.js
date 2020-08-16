const Discord = require('discord.js');
const { Client } = require('pg')

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
};
var state = {
    state: states.LISTEN,
    expiry: new Date(),
    user: undefined,
    next: steps.NONE,
    event: {},
};

const client = new Discord.Client();

const pgClient = new Client({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});
var dbConnected = false;

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
    }
    else if (!message.author.bot) {
        if (message.channel.type === 'dm') {
            console.log(`DM Message ${message.content} from ${message.author.username} in ${message.channel.type}`);
            console.log(`state ${state.state} user ${state.user ? state.user.id : '-'}`);
            if (state.state === states.SETUP && 
                state.user.id === message.author.id) {
                handleStepAnswer(message.content);
            }
        } else {
            console.log(`Message ${message.content} from ${message.author.username} in guild ${message.channel.guild.name} #${message.channel.name}`);
            const bot = client.user;
            console.log(`bot user ID ${bot.id} ${bot.username}`);

            if (message.mentions.has(bot)) {
                console.log(`Message mentions me`);
                if (message.member.permissions.has(Discord.Permissions.FLAGS.MANAGE_GUILD)) {// Check that user is an admin in this guild                     
                    if (message.content.includes('!setup') &&
                        state.state !== states.SETUP) {// one at a time
                        console.log(`user has permission`)
                        // Get any current record for this guild
                        state.event = getEvent(message.guild.name);
                        // start dialog in PM
                        await setupState(message.author, message.guild.name);
                    } else if (message.content.includes('!list')) {
                        console.log(`list event `);
                        const event = await getEvent(message.guild.name);
                        console.log(`event ${JSON.stringify(event)}`);
                        if (event.id) {
                            sendDM(message.author, JSON.stringify(event));
                        } else {
                            console.log(`No current event`);
                            sendDM(message.author, `No event is currently set up for ${message.guild.name}`);
                        }
                    } else if (message.content.includes('!status')) {
                        console.log(`status request`);
                        sendDM(message.author, `Current status: ${state.state}`);
                        const event = await getEvent(message.guild.name);
                        if (event.id) {
                            sendDM(message.author, `Event: ${JSON.stringify(event)}`);
                        }
                    } else {
                        message.reply(`Commands are: !setup, !list, !status`);
                    }
                } else {
                    console.log(`user lacks permission, or invalid command`);
                    message.react('❗');
                }
            } else if (state.state === 'EVENT') {
                // Check that member hasn't already been messaged. - REDIS?

                message.react('👍');
                const user = message.author;
                sendDM(user, 'sending u a PM :smile:');
            }
        }
    }
});

pgClient.on('end', () => {
    dbConnected = false;
})

const checkAndConnectDB = async () => {
    if (!dbConnected) await pgClient.connect();
}

const sendDM = async (user, message) => {
    const dm = await user.createDM();
    dm.send(message);
}

const setupState = async (user, guild) => {
    state.state = states.SETUP;
    state.next = steps.CHANNEL;
    state.dm = await user.createDM();
    state.dm.send(`Hi ${user.username}! You want to set me up for an event in ${guild}? I'll ask for the details, one at a time:`);
    state.dm.send(`First: which channel do you want me to listen to? (${state.event.channel | ''})`);
    state.user = user;
    state.event = getEvent(guild);
    if (!state.event.id) { state.event.server = guild; }
    resetExpiry();
}

const handleStepAnswer = async (answer) => {
    resetExpiry();
    switch (state.next) {
        case steps.CHANNEL: {
            if (answer.startsWith('#')) answer = answer.substring(1);
            state.event.channel = answer; // TODO - confirm that guild has this channel
            state.next = steps.START;
            state.dm.send(`Date and time to start? ${state.event.start_time | ''}`);
            break;
        }
        case steps.START: {
            state.event.start_time = answer;
            state.next = steps.END;
            state.dm.send(`Date and time to end the event? (${state.event.end_time | ''})`);
            break;
        }
        case steps.END: {
            state.event.end_time = answer;
            state.next = steps.START_MSG;
            state.dm.send(`Message to publish at the start of the event? (${state.event.start_message | 'The POAP distribution event is now active. Post a message in this channel to earn your POAP token.'})`);
            break;
        }
        case steps.START_MSG: {
            state.event.start_message = answer;
            state.next = steps.END_MSG;
            state.dm.send(`Message to publish to end the event? (${state.event.end_message | 'The POAP distribution event has ended.' })`);
            break;
        }
        case steps.END_MSG: {
            state.event.end_message = answer;
            state.next = steps.RESPONSE;
            state.dm.send(`Response to send privately to members during the event? (${state.event.response_message | ''})`);
            break;
        }
        case steps.RESPONSE: {
            state.event.response_message = answer;
            state.next = steps.REACTION;
            state.dm.send(`Reaction to public message by channel members during the event? (${state.event.reaction | ':thumbsup:'})`);
            break;
        }
        case steps.REACTION: {
            state.event.reaction = answer;
            state.next = steps.NONE;
            state.dm.send(`OK thanks. That's all done.`);
            clearTimeout(state.expiry);
            saveEvent(state.event);
            clearTimeout(state.expiry);
            clearSetup();
            // Set timer for event start
            startEventTimer(state.event);
            break;
        }
    }
}

const resetExpiry = () => {
    if (state.expiry) {
        clearTimeout(state.expiry);
        state.expiry = setTimeout( () => {
            state.dm.send(`Setup expired before answers received. Start again if you wish to comlete setup.`);
            clearSetup();
        }, 300000 );
    }
}

const clearSetup = () => {
    state.state = states.LISTEN;
    state.dm = undefined;
    state.event = {};
    state.user = undefined;
    state.next = steps.NONE;
}

const startEventTimer = (event) => {
    // get seconds until event start
    const eventStart = Date.parse(event.start_time);
    const millisecs = eventStart - (new Date());
    console.log(`Event starting at ${eventStart}, in ${millisecs/1000} secs`);
    // set timeout. Call startEvent on timeout
    state.eventTimer = setTimeout( startEvent(event), millisecs, event);
}

const startEvent = async (event) => {
    console.log(`event started: ${JSON.stringify(event)}`);
    state.state = states.EVENT;
    // Send the start message to the channel
    sendMessageToChannel(event.server, event.channel, event.start_message);

    const endTime = Date.parse(event.end_time);
    const millisecs = endTime - new Date();
    console.log(`Event ending in ${millisecs/1000} secs`);
    // Set timer for event end
    state.endEventTimer = setTimeout((event) => endEvent(event), millisecs, event);
}

const endEvent = async (event) => {
    console.log(`event ended: ${JSON.stringify(event)}`);
    state.state = states.LISTEN;
    // send the event end message
    sendMessageToChannel(event.server, event.channel, event.end_message);
       
}

const sendMessageToChannel = async (guildName, channelName, message) => {
    console.log(`sendMessageToChannel ${guildName} ${channelName} msg ${message}`);
    const guild = client.guilds.cache.find(guild => (guild.name === guildName));
    if (!guild) {
        console.log(`Guild not found! Client guilds: ${client.guilds.cache}`);
        return;
    }
    const channel = guild.channels.cache.find(channel => (channel.name === channelName));
    if (!channel) {
        console.log(`Channel not found! Guild channels: ${guild.channels.cache.size}`);
        return;
    }
    channel.send(message);
}

// DB functions
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
        if (state.event.id) {
            // UPDATE
            console.log(`Updating... ${event.id} to ${JSON.stringify(event)}`);
            res = await pgClient.query('UPDATE event ' + 
                'SET channel=$1, start_time=$2, end_time=$3, start_message=$4, end_message=$5, response_message=$6, reaction=$7 ' + 
                'WHERE id=$8',
            [event.channel, event.start_time, event.end_time, event.start_message, event.end_message, event.response_message, event.reaction, event.id]);
        } else {
            const uuid = uuidv4();
            console.log(`Inserting... ${uuid} to ${JSON.stringify(event)}`);
            // INSERT
            res = await pgClient.query('INSERT INTO event ' + 
                '(id, server, channel, start_time, end_time, start_message, end_message, response_message, reaction) ' + 
                'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
            [uuid, event.server, event.channel, event.start_time, event.end_time, event.start_message, event.end_message, event.response_message, event.reaction]);
        }
        //console.log(res.rows[0]) // 
        //await pgClient.end()
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

// THIS  MUST  BE  THIS  WAY
client.login(process.env.BOT_TOKEN);
