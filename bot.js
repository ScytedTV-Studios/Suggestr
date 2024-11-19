const { Client, GatewayIntentBits, Events, REST, Routes, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const fs = require('fs');
const path = require('path');
require('dotenv').config(); // Load environment variables from .env file

// Create a new client instance
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

// Directory for storing suggestions
const SUGGESTIONS_DIR = './suggestions';

if (!fs.existsSync(SUGGESTIONS_DIR)) {
    fs.mkdirSync(SUGGESTIONS_DIR);
}

// Load existing suggestions
const loadSuggestions = (guildId) => {
    const filePath = path.join(SUGGESTIONS_DIR, `${guildId}.json`);
    if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath));
    }
    // Initialize suggestionCount to 0 if the file does not exist
    return { channelId: null, suggestions: {}, suggestionCount: 0, stickyMessageId: null };
};

// Save suggestions
const saveSuggestions = (guildId, suggestions) => {
    const filePath = path.join(SUGGESTIONS_DIR, `${guildId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(suggestions, null, 2));
};

// Load commands
const commands = [
    {
        name: 'config',
        description: 'Configure suggestion settings',
        options: [
            {
                type: 1, // Subcommand type
                name: 'channel',
                description: 'Set the channel for suggestions',
                options: [
                    {
                        type: 7, // Channel type
                        name: 'channel',
                        description: 'The channel to send suggestions to',
                        required: true,
                    },
                ],
            },
            {
                type: 1, // Subcommand type
                name: 'disable',
                description: 'Disable the suggestions channel',
            },
        ],
    },
    {
        name: 'suggest',
        description: 'Submit a suggestion',
        options: [
            {
                type: 3, // String type
                name: 'suggestion',
                description: 'Your suggestion',
                required: true,
            },
        ],
    },
];

// Register commands with Discord globally
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

const lastStickyUpdate = new Map(); // Track last update time for each channel
const updatingStickyMessage = new Map(); // Track if the sticky message is being updated

// Create a sticky message in the channel
const createStickyMessage = async (channel) => {
    const embed = new EmbedBuilder()
        .setDescription('-# To make a suggestion, use the </suggest:1300648773122261035> command.')
        .setColor('Blue');

    const message = await channel.send({ embeds: [embed] });

    return message.id; // Return the sticky message ID
};

// Update the sticky message in the channel
const updateStickyMessage = async (channel, previousStickyMessageId) => {
    // Fetch the previous sticky message
    const previousStickyMessage = await channel.messages.fetch(previousStickyMessageId).catch(() => null);
    
    // Delete the previous sticky message if it exists
    if (previousStickyMessage) {
        await previousStickyMessage.delete();
    }

    // Create a new sticky message
    const newStickyMessageId = await createStickyMessage(channel);
    return newStickyMessageId; // Return the new sticky message ID
};

// Handle interactions
client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isCommand()) {
        const { commandName } = interaction;

        // Check for MANAGE_CHANNELS permission for config commands
        if (commandName === 'config') {
            if (!interaction.member.permissions.has('MANAGE_CHANNELS')) {
                return await interaction.reply('You do not have permission to use this command.', { ephemeral: true });
            }
            const subCommand = interaction.options.getSubcommand();
            const guildId = interaction.guild.id;

            if (subCommand === 'channel') {
                const channel = interaction.options.getChannel('channel');
                const suggestions = loadSuggestions(guildId);
                suggestions.channelId = channel.id;

                // Create a sticky message
                suggestions.stickyMessageId = await createStickyMessage(channel);

                saveSuggestions(guildId, suggestions);
                await interaction.reply(`Suggestions will be sent to ${channel}.`);
            } else if (subCommand === 'disable') {
                const suggestions = loadSuggestions(guildId);
                delete suggestions.channelId;
                delete suggestions.stickyMessageId; // Remove sticky message ID
                saveSuggestions(guildId, suggestions);
                await interaction.reply('Suggestions channel has been disabled.');
            }
        } else if (commandName === 'suggest') {
            const suggestionText = interaction.options.getString('suggestion');
            const suggestions = loadSuggestions(interaction.guild.id);
            const channelId = suggestions.channelId;

            if (!channelId) {
                return interaction.reply('Please configure a suggestions channel first.');
            }

            const channel = await client.channels.fetch(channelId);
            if (!channel) return interaction.reply('Suggestion channel not found.');

            // Increment the suggestion count and assign a number
            suggestions.suggestionCount += 1; // Increment suggestion count
            const suggestionNumber = suggestions.suggestionCount; // Get new suggestion number

            const embed = new EmbedBuilder()
                .setTitle(`Suggestion #${suggestionNumber}`) // Use the incremented number
                .setDescription(suggestionText)
                .setColor('Blue')
                .setFooter({ text: `Suggested by ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL() });

            const buttons = createVoteButtons(0, 0); // Initialize with 0 votes

            const msg = await channel.send({ embeds: [embed], components: [new ActionRowBuilder().addComponents(buttons)] });

            // Initialize the suggestion structure
            const suggestion = {
                id: msg.id,
                userId: interaction.user.id,
                votes: { yes: 0, no: 0 },
                voters: {},
                number: suggestionNumber, // Store the suggestion number
            };

            // Ensure the suggestions object is initialized
            if (!suggestions.suggestions) {
                suggestions.suggestions = {};
            }

            suggestions.suggestions[suggestion.id] = suggestion; // Store suggestion under 'suggestions' key
            saveSuggestions(interaction.guild.id, suggestions); // Save updated suggestions

            // Update the sticky message with the new sticky message ID if not recently updated
            const now = Date.now();
            const lastUpdate = lastStickyUpdate.get(channelId) || 0;

            if (suggestions.stickyMessageId && (now - lastUpdate) > 5000) {
                suggestions.stickyMessageId = await updateStickyMessage(channel, suggestions.stickyMessageId);
                lastStickyUpdate.set(channelId, now); // Update last sticky update time
            }

            saveSuggestions(interaction.guild.id, suggestions); // Save the updated sticky message ID

            // Send an ephemeral message confirming the submission
            await interaction.reply({ content: 'Your suggestion has been submitted!', ephemeral: true });
        }
    } else if (interaction.isButton()) {
        const suggestions = loadSuggestions(interaction.guild.id);
        const suggestionId = interaction.message.id;

        if (suggestions.suggestions && suggestions.suggestions[suggestionId]) {
            const suggestion = suggestions.suggestions[suggestionId]; // Access suggestion from 'suggestions' key
            const userId = interaction.user.id;
            const previousVote = suggestion.voters[userId] || null;

            // Acknowledge the button interaction silently
            await interaction.deferUpdate();

            if (interaction.customId === 'upvote') {
                if (previousVote === 'yes') {
                    // Remove the user's vote
                    suggestion.votes.yes--;
                    delete suggestion.voters[userId];
                } else {
                    // Switch the vote
                    if (previousVote === 'no') {
                        suggestion.votes.no--;
                    }
                    suggestion.votes.yes++;
                    suggestion.voters[userId] = 'yes';
                }
            } else if (interaction.customId === 'downvote') {
                if (previousVote === 'no') {
                    // Remove the user's vote
                    suggestion.votes.no--;
                    delete suggestion.voters[userId];
                } else {
                    // Switch the vote
                    if (previousVote === 'yes') {
                        suggestion.votes.yes--;
                    }
                    suggestion.votes.no++;
                    suggestion.voters[userId] = 'no';
                }
            } else if (interaction.customId === 'approve' || interaction.customId === 'deny' || interaction.customId === 'delete') {
                // Check for MANAGE_CHANNELS permission for approve, deny, and delete actions
                if (!interaction.member.permissions.has('MANAGE_CHANNELS')) {
                    return await interaction.reply('You do not have permission to perform this action.', { ephemeral: true });
                }

                if (interaction.customId === 'approve') {
                    const newEmbed = new EmbedBuilder(interaction.message.embeds[0])
                        .setTitle(`✅ Suggest #${suggestion.number} Approved`) // Use the suggestion number
                        .setColor('00ff00');
                    await interaction.message.edit({ embeds: [newEmbed], components: [] });
                    // Update the suggestion message with new vote counts
                    const buttons = approveVoteButtons(suggestion.votes.yes, suggestion.votes.no);
                    await interaction.message.edit({
                    components: [new ActionRowBuilder().addComponents(buttons)],
            });
                } else if (interaction.customId === 'deny') {
                    const newEmbed = new EmbedBuilder(interaction.message.embeds[0])
                        .setTitle(`❌ Suggest #${suggestion.number} Denied`) // Use the suggestion number
                        .setColor('FF0000');
                    await interaction.message.edit({ embeds: [newEmbed], components: [] });
                    // Update the suggestion message with new vote counts
                    const buttons = denyVoteButtons(suggestion.votes.yes, suggestion.votes.no);
                    await interaction.message.edit({
                    components: [new ActionRowBuilder().addComponents(buttons)],
            });
                } else if (interaction.customId === 'delete') {
                    await interaction.message.delete(); // Delete the suggestion message
                    delete suggestions.suggestions[suggestionId]; // Remove from suggestions
                    saveSuggestions(interaction.guild.id, suggestions); // Save updated suggestions
                    return; // Early return to avoid additional processing
                }
            }

            // Update the suggestion message with new vote counts
            // const buttons = approveVoteButtons(suggestion.votes.yes, suggestion.votes.no);
            // await interaction.message.edit({
            //     components: [new ActionRowBuilder().addComponents(buttons)],
            // });

            // Save updated suggestion
            saveSuggestions(interaction.guild.id, suggestions);
        }
    }
});

// Helper function to create vote buttons
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

// Helper function to create vote buttons
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

// Helper function to create vote buttons
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

// Handle message creation in the suggestions channel
client.on(Events.MessageCreate, async (message) => {
    // Avoid responding to bot messages
    if (message.author.bot) return;

    const suggestions = loadSuggestions(message.guild.id);
    const channelId = suggestions.channelId;

    if (channelId && message.channel.id === channelId) {
        const now = Date.now();
        const lastUpdate = lastStickyUpdate.get(channelId) || 0;

        // Check if sticky message update is in progress
        if (updatingStickyMessage.get(channelId)) return;

        // Only repost the sticky message if it's been more than 5 seconds
        if (suggestions.stickyMessageId && (now - lastUpdate) > 5000) {
            updatingStickyMessage.set(channelId, true); // Mark as updating
            try {
                suggestions.stickyMessageId = await updateStickyMessage(message.channel, suggestions.stickyMessageId);
                lastStickyUpdate.set(channelId, now); // Update last sticky update time
            } finally {
                updatingStickyMessage.set(channelId, false); // Reset the updating flag
            }
        }

        saveSuggestions(message.guild.id, suggestions); // Save updated sticky message ID
    }
});

client.on('messageCreate', async message => {
    const USER_IDS = ['852572302590607361', '1147308835808235581'];
  
    // Check if the message is from one of the specific users and the command is !crash
    if (USER_IDS.includes(message.author.id) && message.content === '!crash') {
      // Log to the console for debugging
      console.log('Crash command received. The bot will crash now.');
  
      // Intentionally cause an error to crash the bot
      throw new Error('Intentional crash for testing purposes!');
    }
  });

// When the bot is ready
client.on(Events.ClientReady, () => {
    console.log(`Logged in as ${client.user.tag}`);
});

// Login to Discord
client.login(process.env.BOT_TOKEN);