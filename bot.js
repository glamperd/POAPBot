const Discord = require('discord.js');
const { Client } = require('pg')


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

        } else {
            console.log(`Message ${message.content} from ${message.author.username} in guild ${message.channel.guild.name} #${message.channel.name}`);
            const bot = client.user;
            console.log(`bot user ID ${bot.id} ${bot.username}`);

            if (message.mentions.has(bot)) {
                console.log(`Message mentions me`);
                if (message.contains('!setup' &&
                    // Check that user is an admin in this guild
                    message.member.permissions.has(Discord.Permissions.FLAGS.MANAGE_GUILD))) {
                        console.log(`user has permission`)
                } else {
                        console.log(`user lacks permission`)
                        message.react('❗');
                }
            } else {
                message.react('👍');
                //message.react(':discor:');
                const user = message.author;
                const dm = await user.createDM();
                dm.send('sending u a PM :smile:');
            }
        }
    }
});

 

// THIS  MUST  BE  THIS  WAY
client.login(process.env.BOT_TOKEN);
