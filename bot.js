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

client.on('ready', () => {
    console.log('I am ready!');

    (async () => {
        await pgClient.connect()
        const res = await pgClient.query('SELECT $1::text as message', ['Hello world!'])
        console.log(res.rows[0].message) // Hello world!
        await pgClient.end()
      })()
      
});

client.on('message', async message => {
    if (message.content === 'ping') {
       message.reply('pong');
    }
    else if (!message.author.bot) {
        if (message.channel.type === 'dm') {
            console.log(`DM Message ${message.content} from ${message.author.username} in ${message.channel.type}`);
            if (state.SETUP && 
                state.user.id === message.author.id) {
                handleStepAnswer(message.content);
            }
        } else {
            console.log(`Message ${message.content} from ${message.author.username} in guild ${message.channel.guild.name} #${message.channel.name}`);
            const bot = client.user;
            console.log(`bot user ID ${bot.id} ${bot.username}`);

            if (message.mentions.has(bot)) {
                console.log(`Message mentions me`);
                if (message.content.includes('!setup') &&
                    state !== states.SETUP && // one at a time
                    // Check that user is an admin in this guild
                    message.member.permissions.has(Discord.Permissions.FLAGS.MANAGE_GUILD)) {
                        console.log(`user has permission`)
                        // Get any current record for this guild
                        state.event = getEvent(message.guild.name);
                        // set state to SETUP
                        state = state.SETUP;
                        // start dialog in PM
                        await setupState(message.author);
                }
                else if (message.content.includes('!list') &&
                    // Check that user is an admin in this guild
                    message.member.permissions.has(Discord.Permissions.FLAGS.MANAGE_GUILD)) {
                        console.log(`list event `);
                        const event = getEvent(message.guild.name);
                        if (event) {
                            sendDM(message.author, JSON.stringify(event));
                        } else {
                            console.log(`No current event`);
                            sendDM(message.author, `No event is currently set up for ${message.guild.name}`);
                        }
                } else {
                    console.log(`user lacks permission, or invalid command`);
                    message.react('❗');
                }
            } else {
                message.react('👍');
                const user = message.author;
                sendDM(user, 'sending u a PM :smile:');
            }
        }
    }
});

const sendDM = async (user, message) => {
    const dm = await user.createDM();
    dm.send(message);
}

const setupState = async (user) => {
    state.next = step.CHANNEL;
    state.dm = await user.createDM();
    state.dm.send(`Hi ${user.username}! You want to set me up for an event in ${message.guild.name}? I'll ask for the details, one at a time:`);
    resetExpiry();
}

const handleStepAnswer = async (answer) => {
    switch (state.step) {
        case step.CHANNEL: {
            state.event.channel = answer; // TODO - confirm that guild has this channel
            state.step = step.START;
            state.dm.send(`Date and time to start?`);
            resetExpiry();
            break;
        }
        case step.START: {
            state.event.start = Date.parse(answer);
            state.step = step.END;
            state.dm.send(`Date and time to end the event?`);
            resetExpiry();
            break;
        }
        case step.END: {
            state.event.end = Date.parse(answer);
            state.step = step.START_MSG;
            state.dm.send(`Message to publish at the start of the event?`);
            resetExpiry();
            break;
        }
        case step.START_MSG: {
            state.event.startMessage = answer;
            state.step = step.END_MSG;
            state.dm.send(`Message to publish to end the event?`);
            resetExpiry();
            break;
        }
        case step.END_MSG: {
            state.event.endMessage = answer;
            state.step = step.RESPONSE;
            state.dm.send(`Response to send privately to members during the event?`);
            resetExpiry();
            break;
        }
        case step.RESPONSE: {
            state.event.response = answer;
            state.step = step.REACTION;
            state.dm.send(`Reaction to public message by channel members during the event?`);
            resetExpiry();
            break;
        }
        case step.REACTION: {
            state.event.reaction = answer;
            state.step = step.NONE;
            state.dm.send(`OK thanks. That's all done.`);
            clearTimeout(state.expiry);
            saveEvent(state.event);
            break;
        }
    }
}

const resetExpiry = () => {
    if (state.expiry) {
        clearTimeout(state.expiry);
        state.expiry = setTimeout( () => {
            state.dm.send(`Setup expired before answers received. Start again if you wish to comlete setup.`);
            state.state = state.LISTEN;
            state.dm = undefined;
            state.event = {};
            state.user = undefined;
            state.next = steps.NONE;
        }, 300000 );
    }
}

const getEvent = async (guild) => {
    await pgClient.connect()
    const res = await pgClient.query('SELECT * FROM event WHERE server = $1', [guild]);
    console.log(`Event retrieved from DB: ${JSON.stringify(res.rows[0])}`);
    await pgClient.end();
    if (res.rows.count > 0) {
        return {
            ...res.rows[0],
        };
    } else {
        return {};
    }
}

const saveEvent = async (event) => {
    await pgClient.connect();
    let res;
    if (state.event.uuid) {
        // UPDATE
        res = await pgClient.query('UPDATE event ' + 
            'SET channel=$1, start_time=$2, end_time=$3, start_message=$4, end_message=$5, response_message=$6, reaction=$7 ' + 
            'WHERE uuid=$8',
         [event.channel, event.start, event.end, event.startMessage, event.endMessage, event.response, event.reaction, event.uuid]);
    } else {
        // INSERT
        res = await pgClient.query('INSERT INTO event ' + 
            '(uuid, server, channel, start_time, end_time, start_message, end_message, response_message, reaction) ' + 
            'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
         [uuidv4(), event.guild, event.channel, event.start, event.end, event.startMessage, event.endMessage, event.response, event.reaction]);
    }
    console.log(res.rows[0]) // 
    await pgClient.end()
}

function uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
}

// THIS  MUST  BE  THIS  WAY
client.login(process.env.BOT_TOKEN);
