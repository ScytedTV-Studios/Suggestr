const { Client, GatewayIntentBits, Events, REST, Routes, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField } = require('discord.js');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent,
    ],
});

const SUGGESTIONS_DIR = './suggestions';

if (!fs.existsSync(SUGGESTIONS_DIR)) {
    fs.mkdirSync(SUGGESTIONS_DIR);
}

const loadSuggestions = (guildId) => {
    const filePath = path.join(SUGGESTIONS_DIR, `${guildId}.json`);
    if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath));
    }

    return { channelId: null, suggestions: {}, suggestionCount: 0, stickyMessageId: null };
};

const saveSuggestions = (guildId, suggestions) => {
    const filePath = path.join(SUGGESTIONS_DIR, `${guildId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(suggestions, null, 2));
};

const commands = [
    {
        name: 'config',
        description: 'Configure suggestion settings',
        options: [
            {
                type: 1,
                name: 'channel',
                description: 'Set the channel for suggestions',
                options: [
                    {
                        type: 7,
                        name: 'channel',
                        description: 'The channel to send suggestions to',
                        required: true,
                    },
                ],
            },
            {
                type: 1,
                name: 'disable',
                description: 'Disable the suggestions channel',
            },
            // {
            //     type: 1,
            //     name: 'data',
            //     description: 'See how your data is used and stored',
            // },
        ],
    },
    {
        name: 'suggest',
        description: 'Submit a suggestion',
        options: [
            {
                type: 3,
                name: 'suggestion',
                description: 'Your suggestion',
                required: true,
            },
        ],
    },
];

const rest = new REST({ version: '9' }).setToken(process.env.BOT_TOKEN);

(async () => {
    try {
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), {
            body: commands,
        });
        console.log('Successfully registered application commands globally.');
    } catch (error) {
        console.error(error);
    }
})();

const lastStickyUpdate = new Map();
const updatingStickyMessage = new Map();

const createStickyMessage = async (channel) => {
    const embed = new EmbedBuilder()
        .setDescription('-# To make a suggestion, use the </suggest:1300648773122261035> command.')
        .setColor('Blue');

    const message = await channel.send({ embeds: [embed] });

    return message.id;
};

const updateStickyMessage = async (channel, previousStickyMessageId) => {

    const previousStickyMessage = await channel.messages.fetch(previousStickyMessageId).catch(() => null);

    if (previousStickyMessage) {
        await previousStickyMessage.delete();
    }

    const newStickyMessageId = await createStickyMessage(channel);
    return newStickyMessageId;
};

client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isCommand()) {
        const { commandName } = interaction;

        if (commandName === 'config') {
            await interaction.deferReply();
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageChannel)) {
                const embed = new EmbedBuilder()
                    .setColor('Red')
                    .setDescription('<:crossmark:1330976664535961753> `You do not have permission to use this command.`');
                return await interaction.editReply({ embeds: [embed], ephemeral: true });
            }
            const subCommand = interaction.options.getSubcommand();
            const guildId = interaction.guild.id;

            if (subCommand === 'channel') {
                const channel = interaction.options.getChannel('channel');
                const suggestions = loadSuggestions(guildId);
                suggestions.channelId = channel.id;

                suggestions.stickyMessageId = await createStickyMessage(channel);

                saveSuggestions(guildId, suggestions);

                const embed = new EmbedBuilder()
                    .setColor('Green')
                    .setDescription(`<:checkmark:1330976666016550932> \`Suggestions will be sent to #${channel.name}.\``);
                await interaction.editReply({ embeds: [embed] });

            } else if (subCommand === 'disable') {
                const suggestions = loadSuggestions(guildId);
                delete suggestions.channelId;
                delete suggestions.stickyMessageId;
                saveSuggestions(guildId, suggestions);

                const embed = new EmbedBuilder()
                    .setColor('Green')
                    .setDescription(`<:checkmark:1330976666016550932> \`Suggestions channel has been disabled.\``);
                await interaction.editReply({ embeds: [embed] });

            }
        } else if (commandName === 'suggest') {
            await interaction.deferReply();
            const suggestionText = interaction.options.getString('suggestion');
            const suggestions = loadSuggestions(interaction.guild.id);
            const channelId = suggestions.channelId;

            if (!channelId) {
                const embed = new EmbedBuilder()
                    .setColor('Red')
                    .setDescription('<:crossmark:1330976664535961753> `Please configure a suggestions channel first.`');
                return interaction.editReply({ embeds: [embed], ephemeral: true });
            }

            const channel = await client.channels.fetch(channelId);
            const notFoundEmbed = new EmbedBuilder()
                .setColor('Red')
                .setDescription('<:crossmark:1330976664535961753> `Please configure a suggestions channel first.`');
            if (!channel) return interaction.editReply({ embeds: [notFoundEmbed], ephemeral: true });

            suggestions.suggestionCount += 1;
            const suggestionNumber = suggestions.suggestionCount;

            const embed = new EmbedBuilder()
                .setTitle(`Suggestion #${suggestionNumber}`)
                .setDescription(suggestionText)
                .setColor('Blue')
                .setFooter({ text: `Suggested by ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL() });

            const buttons = createVoteButtons(0, 0);

            const msg = await channel.send({ embeds: [embed], components: [new ActionRowBuilder().addComponents(buttons)] });
            try {
                await msg.pin();
            } catch (err) {
                return;
            }

            const suggestion = {
                id: msg.id,
                userId: interaction.user.id,
                votes: { yes: 0, no: 0 },
                voters: {},
                number: suggestionNumber,
            };

            if (!suggestions.suggestions) {
                suggestions.suggestions = {};
            }

            suggestions.suggestions[suggestion.id] = suggestion;
            saveSuggestions(interaction.guild.id, suggestions);

            const now = Date.now();
            const lastUpdate = lastStickyUpdate.get(channelId) || 0;

            if (suggestions.stickyMessageId && (now - lastUpdate) > 5000) {
                suggestions.stickyMessageId = await updateStickyMessage(channel, suggestions.stickyMessageId);
                lastStickyUpdate.set(channelId, now);
            }

            saveSuggestions(interaction.guild.id, suggestions);

            const submittedEmbed = new EmbedBuilder()
                .setColor('Green')
                .setDescription(`<:checkmark:1330976666016550932> \`Your suggestion has been submitted.\``);
            await interaction.editReply({ embeds: [submittedEmbed], ephemeral: true });

        }
    } else if (interaction.isButton()) {
        const suggestions = loadSuggestions(interaction.guild.id);
        const suggestionId = interaction.message.id;

        if (suggestions.suggestions && suggestions.suggestions[suggestionId]) {
            const suggestion = suggestions.suggestions[suggestionId];
            const userId = interaction.user.id;
            const previousVote = suggestion.voters[userId] || null;

            if (interaction.customId === 'upvote') {

                await interaction.deferUpdate();

                if (previousVote === 'yes') {

                    suggestion.votes.yes--;
                    delete suggestion.voters[userId];
                } else {

                    if (previousVote === 'no') {
                        suggestion.votes.no--;
                    }
                    suggestion.votes.yes++;
                    suggestion.voters[userId] = 'yes';
                }

                const buttons = createVoteButtons(suggestion.votes.yes, suggestion.votes.no);
                await interaction.message.edit({
                    components: [new ActionRowBuilder().addComponents(buttons)],
                });

            } else if (interaction.customId === 'downvote') {

                await interaction.deferUpdate();

                if (previousVote === 'no') {

                    suggestion.votes.no--;
                    delete suggestion.voters[userId];
                } else {

                    if (previousVote === 'yes') {
                        suggestion.votes.yes--;
                    }
                    suggestion.votes.no++;
                    suggestion.voters[userId] = 'no';
                }

                const buttons = createVoteButtons(suggestion.votes.yes, suggestion.votes.no);
                await interaction.message.edit({
                    components: [new ActionRowBuilder().addComponents(buttons)],
                });

            } else if (interaction.customId === 'approve' || interaction.customId === 'deny' || interaction.customId === 'delete') {

                if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
                    const embed = new EmbedBuilder()
                        .setColor('Red')
                        .setDescription('<:crossmark:1330976664535961753> `You do not have permission to perform this action.`');
                    return await interaction.reply({ embeds: [embed], ephemeral: true });
                }

                await interaction.deferUpdate();

                if (interaction.customId === 'approve') {
                    const newEmbed = new EmbedBuilder(interaction.message.embeds[0])
                        .setTitle(`<:checkmark:1330976666016550932> Suggestion #${suggestion.number} Approved`)
                        .setColor('Green');
                    await interaction.message.edit({ embeds: [newEmbed], components: [] });

                    const buttons = approveVoteButtons(suggestion.votes.yes, suggestion.votes.no);
                    await interaction.message.edit({
                        components: [new ActionRowBuilder().addComponents(buttons)],
                    });
                } else if (interaction.customId === 'deny') {
                    const newEmbed = new EmbedBuilder(interaction.message.embeds[0])
                        .setTitle(`<:crossmark:1330976664535961753> Suggestion #${suggestion.number} Denied`)
                        .setColor('Red');
                    await interaction.message.edit({ embeds: [newEmbed], components: [] });

                    const buttons = denyVoteButtons(suggestion.votes.yes, suggestion.votes.no);
                    await interaction.message.edit({
                        components: [new ActionRowBuilder().addComponents(buttons)],
                    });
                } else if (interaction.customId === 'delete') {
                    await interaction.message.delete();
                    delete suggestions.suggestions[suggestionId];
                    saveSuggestions(interaction.guild.id, suggestions);
                    return;
                }
            }

            saveSuggestions(interaction.guild.id, suggestions);
        }
    }
});

const approveVoteButtons = (yesVotes, noVotes) => [
    new ButtonBuilder()
        .setCustomId('upvote')
        .setLabel(`👍 ${yesVotes}`)
        .setStyle(ButtonStyle.Primary)
        .setDisabled(true),
    new ButtonBuilder()
        .setCustomId('downvote')
        .setLabel(`👎 ${noVotes}`)
        .setStyle(ButtonStyle.Primary)
        .setDisabled(true),
    new ButtonBuilder()
        .setCustomId('approve')
        .setLabel('✅ Approve')
        .setStyle(ButtonStyle.Success)
        .setDisabled(true),
    new ButtonBuilder()
        .setCustomId('deny')
        .setLabel('❌ Deny')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(false),
    new ButtonBuilder()
        .setCustomId('delete')
        .setLabel('🗑️')
        .setStyle(ButtonStyle.Secondary),
];

const denyVoteButtons = (yesVotes, noVotes) => [
    new ButtonBuilder()
        .setCustomId('upvote')
        .setLabel(`👍 ${yesVotes}`)
        .setStyle(ButtonStyle.Primary)
        .setDisabled(true),
    new ButtonBuilder()
        .setCustomId('downvote')
        .setLabel(`👎 ${noVotes}`)
        .setStyle(ButtonStyle.Primary)
        .setDisabled(true),
    new ButtonBuilder()
        .setCustomId('approve')
        .setLabel('✅ Approve')
        .setStyle(ButtonStyle.Success)
        .setDisabled(false),
    new ButtonBuilder()
        .setCustomId('deny')
        .setLabel('❌ Deny')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(true),
    new ButtonBuilder()
        .setCustomId('delete')
        .setLabel('🗑️')
        .setStyle(ButtonStyle.Secondary),
];

const createVoteButtons = (yesVotes, noVotes) => [
    new ButtonBuilder()
        .setCustomId('upvote')
        .setLabel(`👍 ${yesVotes}`)
        .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
        .setCustomId('downvote')
        .setLabel(`👎 ${noVotes}`)
        .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
        .setCustomId('approve')
        .setLabel('✅ Approve')
        .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
        .setCustomId('deny')
        .setLabel('❌ Deny')
        .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
        .setCustomId('delete')
        .setLabel('🗑️')
        .setStyle(ButtonStyle.Secondary),
];

client.on(Events.MessageCreate, async (message) => {

    if (message.author.bot) return;

    const suggestions = loadSuggestions(message.guild.id);
    const channelId = suggestions.channelId;

    if (channelId && message.channel.id === channelId) {
        const now = Date.now();
        const lastUpdate = lastStickyUpdate.get(channelId) || 0;

        if (updatingStickyMessage.get(channelId)) return;

        if (suggestions.stickyMessageId && (now - lastUpdate) > 5000) {
            updatingStickyMessage.set(channelId, true);
            try {
                suggestions.stickyMessageId = await updateStickyMessage(message.channel, suggestions.stickyMessageId);
                lastStickyUpdate.set(channelId, now);
            } finally {
                updatingStickyMessage.set(channelId, false);
            }
        }

        saveSuggestions(message.guild.id, suggestions);
    }
});

client.on('messageCreate', async message => {
    const USER_IDS = ['852572302590607361', '1147308835808235581'];

    if (USER_IDS.includes(message.author.id) && message.content === '!crash') {

        console.log('Crash command received. The bot will crash now.');

        throw new Error('Intentional crash for testing purposes!');
    }
});

client.on('messageCreate', async message => {
    const USER_IDS = ['852572302590607361', '1147308835808235581'];

    if (USER_IDS.includes(message.author.id) && message.content === '!crash suggestr') {

        console.log('Crash command received. The bot will crash now.');

        throw new Error('Intentional crash for testing purposes!');
    }
});

client.on(Events.ClientReady, () => {
    console.log(`Logged in as ${client.user.tag}`);
});

client.login(process.env.BOT_TOKEN);