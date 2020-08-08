const Discord = require('discord.js');
const { Client } = require('pg')


const client = new Discord.Client();
const pgClient = new Client({
    user: process.env.DB_USER,
    host: 'localhost',
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
            message.react('👍');
            //message.react(':discor:');
            const user = message.author;
            const dm = await user.createDM();
            dm.send('sending u a PM :smile:');
        }
    }
});

 

// THIS  MUST  BE  THIS  WAY
client.login(process.env.BOT_TOKEN);
