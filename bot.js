const Discord = require('discord.js');

const client = new Discord.Client();


client.on('ready', () => {
    console.log('I am ready!');
});

 

client.on('message', async message => {
    if (message.content === 'ping') {
       message.reply('pong');
       }
    else {
        console.log(`Message ${message.content} from ${message.author.username}`);
        message.react('👍');
        //message.react(':discor:');
        const user = message.author;
        const dm = await user.createDM();
        dm.send('sending u a PM :smile:');
    }
});

 

// THIS  MUST  BE  THIS  WAY
client.login(process.env.BOT_TOKEN);
