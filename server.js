/**
 * WhatsApp to Slack Integration
 *
 * This application receives inbound WhatsApp messages from Vonage AI Studio
 * and forwards them to Slack. It handles:
 * - Live agent routing from AI Studio
 * - Bidirectional messaging between WhatsApp users and Slack agents
 * - Thread-based conversation management in Slack
 *
 * Flow:
 * 1. User sends WhatsApp message → AI Studio virtual agent
 * 2. If escalation needed → AI Studio calls /start endpoint
 * 3. New conversation appears in Slack channel as a thread
 * 4. Agent replies in thread → message automatically sent to WhatsApp user
 * 5. User responses → forwarded to Slack thread via /inbound
 * 6. Agent clicks "Close Ticket" button → conversation ends
 */

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cloudinary = require('cloudinary').v2;
const { createClient } = require('redis');
const { parsePhoneNumberFromString } = require('libphonenumber-js');

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Configure Redis
const redis = createClient({
  url: process.env.REDIS_URL || 'redis://redis.railway.internal:6379',
});

redis.on('error', (err) => console.error('❌ Redis error:', err));
redis.on('connect', () => console.log('✅ Connected to Redis'));

const app = express();
const PORT = process.env.PORT || 3000;

// Environment variables
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID;
const AI_STUDIO_KEY = process.env.AI_STUDIO_KEY;
const AI_STUDIO_REGION = process.env.AI_STUDIO_REGION || 'eu';

// AI Studio API base URL based on region
const AI_STUDIO_BASE_URL = `https://studio-api-${AI_STUDIO_REGION}.ai.vonage.com`;

// In-memory map of pending auto-response timers per session
const pendingTimers = new Map();

// ============================================
// Translatable Strings
// ============================================
const STRINGS = {
  // New ticket message
  newRequest: '🆕 *New WhatsApp Support Request*',
  closeButton: '✅ Close Ticket',
  closeConfirmTitle: 'Close Ticket',
  closeConfirmText: 'Are you sure you want to close this ticket?',
  closeConfirmYes: 'Yes, close it',
  closeConfirmNo: 'Cancel',
  replyInThread: '💬 Reply in this thread to respond',
  noMessages: '_No previous messages_',

  // Intent types
  intentTypes: {
    'registration': '📝 Registration',
    'payment': '💳 Payment',
    'inquiry': '❓ Inquiry',
  },

  // School types
  schoolTypes: {
    'academy': '🎓 Academy',
    'daycare': '👶 Daycare',
  },

  // Inbound messages from customer
  customerImage: '📱 *Customer sent an image:*',
  customerVideo: '📱 *Customer sent a video:*',
  customerAudio: '📱 *Customer sent an audio message:*',
  customerText: '📱 *Customer:*',

  // Status messages
  ticketClosed: '✅ *Ticket closed*',
  messageSentToWhatsApp: '✅ _Message sent to WhatsApp_',

  // Errors
  unsupportedFileType: '⚠️ Cannot send {type} files to WhatsApp. Only images, videos, and audio are supported.',
  failedToSendFile: '❌ Failed to send file to WhatsApp: {error}',
  sessionNotFound: 'Session not found',

  assignedTo: '👋 Assigned to',
  saveContactButton: '📇 Save Contact',
  saveContactModalTitle: 'Save Contact',
  saveContactNameLabel: 'Contact Name',
  saveContactSaved: '📇 Contact saved as *{name}*',

  // Auto-response messages sent to customer when no agent has replied
  busyMessage3Min: 'Thank you for your patience. Our team is currently busy and will be with you shortly.',
  busyMessage10Min: 'We apologize for the delay. Our team is experiencing high volume but we haven\'t forgotten about you. Someone will be with you as soon as possible.',
  busyNotice: '⏱️ _Auto-message sent to customer:_ "{message}"',
};

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check endpoint
app.get('/health', async (req, res) => {
  const keys = await redis.keys('session:*');
  res.json({ status: 'ok', sessions: keys.length });
});

/**
 * /contact/check - Check if a phone number has a saved contact
 *
 * Query params:
 *   phone - The phone number to check (required)
 *
 * Returns:
 *   "true" or "false" (plain text)
 */
app.get('/contact/check', async (req, res) => {
  try {
    const phone = req.query.phone;
    console.log(`🔍 Checking contact for phone number: ${phone}`);
    if (!phone) {
      return res.json({ is_saved: false });
    }

    const contactData = await redis.get(`contact:${phone}`);
    res.json({ is_saved: !!contactData });
  } catch (error) {
    console.error('❌ Error checking contact:', error.message);
    res.json({ is_saved: false });
  }
});

/**
 * /start - Called by AI Studio when live agent routing begins
 *
 * This endpoint is triggered when a WhatsApp user requests human support.
 * It creates a new message in Slack with the conversation history.
 */
app.post('/start', async (req, res) => {
  try {
    console.log('📥 Start endpoint received:', JSON.stringify(req.body, null, 2));

    const sessionId = req.body.sessionId;

    // Extract parameters from history
    const params = extractParameters(req.body.history?.parameters);
    const phoneNumber = params.SENDER_PHONE_NUMBER || '';
    const intent = params['USER.intent'] || '';
    const school = params['USER.school'] || '';

    // Use saved contact name if available, otherwise WhatsApp profile name
    let profileName = params.PROFILE_NAME || 'Unknown';
    if (phoneNumber) {
      const savedContact = await redis.get(`contact:${phoneNumber}`);
      if (savedContact) {
        profileName = JSON.parse(savedContact).name;
      }
    }

    // Format intent and school
    const intentType = STRINGS.intentTypes[intent] || intent;
    const schoolType = STRINGS.schoolTypes[school] || school;

    // Look up assigned users
    const assigneeIds = await getAssignees(school, intent);

    let messageText = `${STRINGS.newRequest}\n\n`;
    messageText += `👤 *${profileName}*`;
    if (phoneNumber) messageText += ` • ${formatPhoneNumber(phoneNumber)}`;
    messageText += `\n`;
    if (intentType) messageText += `${intentType}`;
    if (intentType && schoolType) messageText += ` • `;
    if (schoolType) messageText += `${schoolType}`;
    if (intentType || schoolType) messageText += `\n`;
    if (assigneeIds.length > 0) {
      const mentions = assigneeIds.map(id => `<@${id}>`).join(', ');
      messageText += `\n${STRINGS.assignedTo} ${mentions}\n`;
    }
    messageText += `\n${STRINGS.replyInThread}`;

    // Build blocks with action buttons
    const actionElements = [
      {
        type: 'button',
        text: { type: 'plain_text', text: STRINGS.closeButton },
        style: 'danger',
        action_id: 'close_ticket',
        confirm: {
          title: { type: 'plain_text', text: STRINGS.closeConfirmTitle },
          text: { type: 'mrkdwn', text: STRINGS.closeConfirmText },
          confirm: { type: 'plain_text', text: STRINGS.closeConfirmYes },
          deny: { type: 'plain_text', text: STRINGS.closeConfirmNo },
        },
      },
    ];

    if (phoneNumber) {
      actionElements.push({
        type: 'button',
        text: { type: 'plain_text', text: STRINGS.saveContactButton },
        action_id: 'save_contact',
        value: JSON.stringify({ phone: phoneNumber, name: profileName }),
      });
    }

    const blocks = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: messageText },
      },
      {
        type: 'actions',
        elements: actionElements,
      },
    ];

    // Use Slack API to get the message timestamp for threading
    const response = await axios.post(
      'https://slack.com/api/chat.postMessage',
      {
        channel: SLACK_CHANNEL_ID,
        text: messageText,
        blocks: blocks,
      },
      {
        headers: {
          'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!response.data.ok) {
      throw new Error(`Slack API error: ${response.data.error}`);
    }

    // Auto-create session with the thread timestamp
    const threadTs = response.data.ts;
    await saveSession(sessionId, threadTs, profileName);

    // Schedule auto-response messages in case no agent replies
    scheduleAutoResponses(sessionId);

    console.log(`✅ Conversation initiated in Slack, session ${sessionId} linked to thread ${threadTs}`);

    res.status(200).json({ status: 'success', message: 'Conversation started in Slack' });
  } catch (error) {
    console.error('❌ Error in /start:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * /inbound - Called by AI Studio when user sends a message during live agent session
 *
 * Forwards the WhatsApp user's message to the appropriate Slack thread.
 * Handles text, image, and video messages.
 */
app.post('/inbound', async (req, res) => {
  try {
    console.log('📥 Inbound message received:', JSON.stringify(req.body, null, 2));

    const sessionId = req.body.sessionId;
    const messageType = req.body.type || 'text';
    const session = await getSession(sessionId);

    if (!session) {
      console.warn('⚠️ No session found for:', sessionId);
      res.status(200).json({ status: 'warning', message: STRINGS.sessionNotFound });
      return;
    }

    // Use customer's name as the message sender
    const customerName = session.profile_name || 'Customer';
    const baseMessage = {
      channel: SLACK_CHANNEL_ID,
      thread_ts: session.thread_ts,
      username: customerName,
      icon_emoji: ':bust_in_silhouette:',
    };

    let slackMessage;

    switch (messageType) {
      case 'image': {
        const imageCaption = req.body.image.caption ? `\n"${req.body.image.caption}"` : '';
        slackMessage = {
          ...baseMessage,
          text: `${STRINGS.customerImage}${imageCaption}`,
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: `${STRINGS.customerImage}${imageCaption}` }
            },
            {
              type: 'image',
              image_url: req.body.image.url,
              alt_text: req.body.image.caption || req.body.image.name
            }
          ]
        };
        break;
      }

      case 'video': {
        const videoCaption = req.body.video.caption ? `\n"${req.body.video.caption}"` : '';
        slackMessage = {
          ...baseMessage,
          text: `${STRINGS.customerVideo}${videoCaption}\n${req.body.video.url}`
        };
        break;
      }

      case 'audio': {
        slackMessage = {
          ...baseMessage,
          text: `${STRINGS.customerAudio}\n🎵 ${req.body.audio.url}`
        };
        break;
      }

      default: // text
        slackMessage = {
          ...baseMessage,
          text: req.body.text
        };
    }

    await axios.post(
      'https://slack.com/api/chat.postMessage',
      slackMessage,
      {
        headers: {
          'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log(`✅ ${messageType} message forwarded to Slack thread`);

    res.status(200).json({ status: 'success' });
  } catch (error) {
    console.error('❌ Error in /inbound:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * /slack/assign - Slash command to assign users to ticket types
 *
 * Usage:
 *   /assign academy registration @user - Assign user to academy registrations
 *   /assign daycare payment @user - Assign user to daycare payments
 *   /assign list - Show all assignments
 *   /assign clear academy registration - Remove an assignment
 */
app.post('/slack/assign', async (req, res) => {
  try {
    const text = req.body.text?.trim() || '';
    const parts = text.split(/\s+/);
    const command = parts[0]?.toLowerCase();

    // Show help
    if (command === 'help' || !command) {
      return res.json({
        response_type: 'ephemeral',
        text: `📖 */assign* - Manage ticket assignments\n\n` +
          `*Commands:*\n` +
          `• \`/assign <school> <intent> @user @user2\` - Assign users\n` +
          `• \`/assign list\` - Show all assignments\n` +
          `• \`/assign clear <school> <intent>\` - Remove all\n` +
          `• \`/assign clear <school> <intent> @user\` - Remove specific user\n` +
          `• \`/assign help\` - Show this help\n\n` +
          `*Schools:* \`academy\`, \`daycare\`\n` +
          `*Intents:* \`registration\`, \`payment\`, \`inquiry\`\n\n` +
          `*Examples:*\n` +
          `• \`/assign academy registration @john @jane\`\n` +
          `• \`/assign daycare payment @jane\`\n` +
          `• \`/assign clear academy registration @john\``,
      });
    }

    // List all assignments
    if (command === 'list') {
      const assignments = await getAllAssignments();
      if (Object.keys(assignments).length === 0) {
        return res.json({
          response_type: 'ephemeral',
          text: '📋 *No assignments configured*\n\nUse `/assign <school> <intent> @user` to create one.',
        });
      }

      let response = '📋 *Current Assignments:*\n\n';
      for (const [key, userIds] of Object.entries(assignments)) {
        const [school, intent] = key.split(':');
        const schoolLabel = STRINGS.schoolTypes[school] || school;
        const intentLabel = STRINGS.intentTypes[intent] || intent;
        const mentions = userIds.map(id => `<@${id}>`).join(', ');
        response += `• ${schoolLabel} + ${intentLabel} → ${mentions}\n`;
      }
      return res.json({ response_type: 'ephemeral', text: response });
    }

    // Clear an assignment
    if (command === 'clear') {
      const school = parts[1]?.toLowerCase();
      const userType = parts[2]?.toLowerCase();

      if (!school || !userType) {
        return res.json({
          response_type: 'ephemeral',
          text: '❌ Usage:\n`/assign clear <school> <intent>` - Remove all\n`/assign clear <school> <intent> @user` - Remove specific user\n\nType `/assign help` for more info.',
        });
      }

      // Check if a specific user is mentioned
      const userIds = await resolveUsers(text);

      if (userIds.length > 0) {
        // Remove specific users
        for (const uid of userIds) {
          await redis.sRem(`assign:${school}:${userType}`, uid);
        }
        const mentions = userIds.map(id => `<@${id}>`).join(', ');
        return res.json({
          response_type: 'in_channel',
          text: `✅ Removed ${mentions} from ${school} + ${userType}`,
        });
      }

      // Remove all
      await redis.del(`assign:${school}:${userType}`);
      return res.json({
        response_type: 'in_channel',
        text: `✅ Cleared all assignments for ${school} + ${userType}`,
      });
    }

    // Create an assignment: /assign <school> <intent> @user @user2 ...
    const school = parts[0]?.toLowerCase();
    const userType = parts[1]?.toLowerCase();

    if (!school || !userType) {
      return res.json({
        response_type: 'ephemeral',
        text: '❌ Usage: `/assign <school> <intent> @user`\nExample: `/assign academy registration @john`\n\nType `/assign help` for more info.',
      });
    }

    // Extract all user IDs from mentions
    const userIds = await resolveUsers(text);

    if (userIds.length === 0) {
      return res.json({
        response_type: 'ephemeral',
        text: '❌ Please mention at least one user with @username\nExample: `/assign academy registration @john @jane`',
      });
    }

    // Add all users to the assignment set
    for (const uid of userIds) {
      await redis.sAdd(`assign:${school}:${userType}`, uid);
    }

    const schoolLabel = STRINGS.schoolTypes[school] || school;
    const intentLabel = STRINGS.intentTypes[userType] || userType;
    const mentions = userIds.map(id => `<@${id}>`).join(', ');

    return res.json({
      response_type: 'in_channel',
      text: `✅ Assigned ${mentions} to handle ${schoolLabel} + ${intentLabel} tickets`,
    });

  } catch (error) {
    console.error('❌ Error in /slack/assign:', error.message);
    return res.json({
      response_type: 'ephemeral',
      text: `❌ Error: ${error.message}`,
    });
  }
});

/**
 * /slack/events - Slack Events API handler
 *
 * Handles:
 * - Thread messages → automatically forwarded to WhatsApp
 */
app.post('/slack/events', async (req, res) => {
  try {
    // Handle Slack URL verification challenge
    if (req.body.type === 'url_verification') {
      console.log('🔐 Slack URL verification');
      return res.json({ challenge: req.body.challenge });
    }

    // Acknowledge immediately to prevent Slack timeout
    res.status(200).send('');

    const event = req.body.event;
    if (!event) return;

    // Handle message events (for auto-reply)
    if (event.type === 'message') {
      await handleMessage(event);
      return;
    }

  } catch (error) {
    console.error('❌ Error in /slack/events:', error.message);
  }
});

/**
 * /slack/interactions - Slack Interactive Components handler
 *
 * Handles button clicks (e.g. Close Ticket button)
 */
app.post('/slack/interactions', async (req, res) => {
  try {
    const payload = JSON.parse(req.body.payload);

    // Handle modal submission
    if (payload.type === 'view_submission') {
      const callbackId = payload.view.callback_id;
      if (callbackId === 'save_contact_modal') {
        const name = payload.view.state.values.contact_name_block.contact_name_input.value;
        const meta = JSON.parse(payload.view.private_metadata);
        const phone = meta.phone;

        // Save contact to Redis
        await redis.set(`contact:${phone}`, JSON.stringify({ name, phone, saved_at: new Date().toISOString() }));

        const channelId = meta.channel_id || SLACK_CHANNEL_ID;

        // Post confirmation in the thread
        if (meta.thread_ts) {
          await axios.post(
            'https://slack.com/api/chat.postMessage',
            {
              channel: channelId,
              thread_ts: meta.thread_ts,
              text: STRINGS.saveContactSaved.replace('{name}', name),
            },
            {
              headers: {
                'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
                'Content-Type': 'application/json',
              },
            }
          );

          // Remove the Save Contact button from the original message
          if (meta.blocks) {
            const updatedBlocks = meta.blocks.map(block => {
              if (block.type === 'actions') {
                return {
                  ...block,
                  elements: block.elements.filter(el => el.action_id !== 'save_contact'),
                };
              }
              return block;
            });

            await axios.post(
              'https://slack.com/api/chat.update',
              {
                channel: channelId,
                ts: meta.thread_ts,
                blocks: updatedBlocks,
              },
              {
                headers: {
                  'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
                  'Content-Type': 'application/json',
                },
              }
            );
          }
        }

        console.log(`📇 Contact saved: ${name} (${phone})`);
        return res.status(200).json({ response_action: 'clear' });
      }
      return res.status(200).send('');
    }

    // Acknowledge immediately
    res.status(200).send('');

    if (payload.type !== 'block_actions') return;

    const action = payload.actions?.[0];
    if (!action) return;

    // Handle "Save Contact" — open a modal
    if (action.action_id === 'save_contact') {
      const data = JSON.parse(action.value);
      const messageTs = payload.message.ts;
      const channelId = payload.channel.id;

      // Check if contact already exists
      const existing = await redis.get(`contact:${data.phone}`);
      const defaultName = existing ? JSON.parse(existing).name : data.name;

      await axios.post(
        'https://slack.com/api/views.open',
        {
          trigger_id: payload.trigger_id,
          view: {
            type: 'modal',
            callback_id: 'save_contact_modal',
            private_metadata: JSON.stringify({ phone: data.phone, thread_ts: messageTs, channel_id: channelId, blocks: payload.message.blocks }),
            title: { type: 'plain_text', text: STRINGS.saveContactModalTitle },
            submit: { type: 'plain_text', text: 'Save' },
            close: { type: 'plain_text', text: 'Cancel' },
            blocks: [
              {
                type: 'input',
                block_id: 'contact_name_block',
                label: { type: 'plain_text', text: STRINGS.saveContactNameLabel },
                element: {
                  type: 'plain_text_input',
                  action_id: 'contact_name_input',
                  initial_value: defaultName,
                },
              },
            ],
          },
        },
        {
          headers: {
            'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
            'Content-Type': 'application/json',
          },
        }
      );
      return;
    }

    if (action.action_id !== 'close_ticket') return;

    const messageTs = payload.message.ts;
    const channelId = payload.channel.id;

    // Find session by thread (the message ts is the thread parent)
    const session = await getSessionByThread(messageTs);
    if (!session) {
      console.warn('⚠️ No session found for thread:', messageTs);
      return;
    }

    console.log(`🔒 Closing ticket for session ${session.session_id}`);

    // Tell AI Studio to end the conversation
    await axios.post(
      `${AI_STUDIO_BASE_URL}/live-agent/disconnect/${session.session_id}`,
      {},
      { headers: { 'X-Vgai-Key': AI_STUDIO_KEY } }
    );

    // Post closure message in thread
    await axios.post(SLACK_WEBHOOK_URL, {
      thread_ts: messageTs,
      text: STRINGS.ticketClosed,
    });

    // Update the original message: remove Close Ticket button but keep Save Contact
    const originalText = payload.message.blocks?.[0]?.text?.text || payload.message.text;
    const updatedBlocks = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: originalText },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: STRINGS.ticketClosed },
      },
    ];

    // Preserve the Save Contact button if it exists
    const actionsBlock = payload.message.blocks?.find(b => b.type === 'actions');
    if (actionsBlock) {
      const saveContactBtn = actionsBlock.elements?.find(el => el.action_id === 'save_contact');
      if (saveContactBtn) {
        updatedBlocks.push({
          type: 'actions',
          elements: [saveContactBtn],
        });
      }
    }

    await axios.post(
      'https://slack.com/api/chat.update',
      {
        channel: channelId,
        ts: messageTs,
        text: originalText,
        blocks: updatedBlocks,
      },
      {
        headers: {
          'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );

    // Clean up session from Redis
    await deleteSession(session.session_id, messageTs);
    console.log(`✅ Session ${session.session_id} closed`);

  } catch (error) {
    console.error('❌ Error in /slack/interactions:', error.message);
  }
});

/**
 * Handle message events - forward thread replies to WhatsApp
 */
async function handleMessage(event) {
  // Ignore bot messages
  if (event.bot_id || event.subtype === 'bot_message') {
    return;
  }

  // Only process threaded messages
  if (!event.thread_ts || event.thread_ts === event.ts) {
    return;
  }

  const threadTs = event.thread_ts;

  // Find session by thread
  const session = await getSessionByThread(threadTs);
  if (!session) {
    return;
  }

  // Agent has replied — cancel any pending auto-response timers
  cancelAutoResponses(session.session_id);

  // Handle file uploads
  if (event.files && event.files.length > 0) {
    for (const file of event.files) {
      await handleFileUpload(file, session, threadTs, event.text);
    }
    return;
  }

  // Handle text messages
  const message = event.text;
  if (!message) return;

  console.log(`📤 Auto-forwarding message to WhatsApp for session ${session.session_id}`);

  await axios.post(
    `${AI_STUDIO_BASE_URL}/live-agent/outbound/${session.session_id}`,
    { message_type: 'text', text: message },
    { headers: { 'X-Vgai-Key': AI_STUDIO_KEY } }
  );

  console.log('✅ Message sent to WhatsApp');
}

/**
 * Handle file uploads from Slack - upload to Cloudinary and send to WhatsApp
 */
async function handleFileUpload(file, session, threadTs, caption) {
  try {
    const fileType = file.mimetype?.split('/')[0]; // 'image', 'video', 'audio', etc.

    if (!['image', 'video', 'audio'].includes(fileType)) {
      console.log(`⚠️ Unsupported file type: ${file.mimetype}`);
      await axios.post(SLACK_WEBHOOK_URL, {
        thread_ts: threadTs,
        text: STRINGS.unsupportedFileType.replace('{type}', file.mimetype),
      });
      return;
    }

    console.log(`📤 Uploading ${fileType} to Cloudinary...`);

    // Download file from Slack (requires bot token for private files)
    const fileResponse = await axios.get(file.url_private_download || file.url_private, {
      headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}` },
      responseType: 'arraybuffer',
    });

    // Upload to Cloudinary
    const resourceType = fileType === 'image' ? 'image' : 'video'; // Cloudinary uses 'video' for both video and audio
    const uploadResult = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        { resource_type: resourceType },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      uploadStream.end(Buffer.from(fileResponse.data));
    });

    console.log(`✅ Uploaded to Cloudinary: ${uploadResult.secure_url}`);

    // Send to Vonage AI Studio
    const payload = {
      message_type: fileType,
      [fileType]: {
        url: uploadResult.secure_url,
      },
    };

    // Add caption if provided
    if (caption) {
      payload[fileType].caption = caption;
    }

    await axios.post(
      `${AI_STUDIO_BASE_URL}/live-agent/outbound/${session.session_id}`,
      payload,
      { headers: { 'X-Vgai-Key': AI_STUDIO_KEY } }
    );

    console.log(`✅ ${fileType} sent to WhatsApp`);

  } catch (error) {
    console.error(`❌ Error handling file upload:`, error.message);
    await axios.post(SLACK_WEBHOOK_URL, {
      thread_ts: threadTs,
      text: STRINGS.failedToSendFile.replace('{error}', error.message),
    });
  }
}

// ============================================
// Helper Functions
// ============================================

/**
 * Format a phone number for display using libphonenumber-js
 */
function formatPhoneNumber(number) {
  if (!number) return '';
  const phone = parsePhoneNumberFromString('+' + number.replace(/\D/g, ''));
  if (phone) return phone.formatInternational();
  return number;
}

/**
 * Extract parameters from AI Studio history into a key-value object
 */
function extractParameters(parameters = []) {
  const result = {};
  if (!parameters || !parameters.length) return result;

  for (const param of parameters) {
    if (param.name && param.value) {
      result[param.name] = param.value;
    }
  }
  return result;
}

// ============================================
// Redis Assignment Management
// ============================================

/**
 * Get all assignments from Redis
 */
async function getAllAssignments() {
  const keys = await redis.keys('assign:*');
  const assignments = {};

  for (const key of keys) {
    const userIds = await redis.sMembers(key);
    if (userIds.length > 0) {
      const shortKey = key.replace('assign:', '');
      assignments[shortKey] = userIds;
    }
  }

  return assignments;
}

/**
 * Get assignees for a school/intent combination
 * Returns an array of user IDs
 */
async function getAssignees(school, intent) {
  if (!school && !intent) return [];

  // Try exact match first
  if (school && intent) {
    const exact = await redis.sMembers(`assign:${school}:${intent}`);
    if (exact.length > 0) return exact;
  }

  return [];
}

/**
 * Resolve @mentions and plain @usernames to Slack user IDs
 */
async function resolveUsers(text) {
  const userIds = [];

  // Find all formatted mentions: <@U123456> or <@U123456|display name>
  const formattedMatches = text.matchAll(/<@([A-Z0-9]+)(\|[^>]+)?>/gi);
  for (const match of formattedMatches) {
    userIds.push(match[1]);
  }

  if (userIds.length > 0) return userIds;

  // Fall back to plain @username mentions
  const plainMatches = text.matchAll(/@(\S+)/g);
  const usernames = [];
  for (const match of plainMatches) {
    usernames.push(match[1]);
  }

  if (usernames.length === 0) return [];

  // Look up users via Slack API
  try {
    const lookupResponse = await axios.get(
      `https://slack.com/api/users.list`,
      { headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}` } }
    );

    if (!lookupResponse.data.ok) {
      throw new Error(lookupResponse.data.error);
    }

    for (const username of usernames) {
      const user = lookupResponse.data.members.find(
        m => m.name === username ||
             m.profile?.display_name?.toLowerCase() === username.toLowerCase() ||
             m.real_name?.toLowerCase() === username.toLowerCase()
      );
      if (user) {
        userIds.push(user.id);
      }
    }
  } catch (err) {
    console.error('❌ Error looking up users:', err.message);
  }

  return userIds;
}

// ============================================
// Auto-Response Timers
// ============================================

/**
 * Schedule auto-response messages for when no agent has replied yet.
 * Sends a "busy" message to the customer at 3 minutes and 10 minutes.
 */
function scheduleAutoResponses(sessionId) {
  const threeMin = setTimeout(() => sendBusyMessage(sessionId, STRINGS.busyMessage3Min), 3 * 60 * 1000);
  const tenMin = setTimeout(() => sendBusyMessage(sessionId, STRINGS.busyMessage10Min), 10 * 60 * 1000);
  pendingTimers.set(sessionId, { threeMin, tenMin });
}

/**
 * Cancel pending auto-response timers for a session.
 */
function cancelAutoResponses(sessionId) {
  const timers = pendingTimers.get(sessionId);
  if (timers) {
    clearTimeout(timers.threeMin);
    clearTimeout(timers.tenMin);
    pendingTimers.delete(sessionId);
    console.log(`⏱️ Auto-response timers cancelled for session ${sessionId}`);
  }
}

/**
 * Send a busy/delay message to the WhatsApp customer and notify the Slack thread.
 */
async function sendBusyMessage(sessionId, message) {
  try {
    const session = await getSession(sessionId);
    if (!session) return;

    // Send to WhatsApp customer
    await axios.post(
      `${AI_STUDIO_BASE_URL}/live-agent/outbound/${session.session_id}`,
      { message_type: 'text', text: message },
      { headers: { 'X-Vgai-Key': AI_STUDIO_KEY } }
    );

    // Notify in Slack thread
    await axios.post(SLACK_WEBHOOK_URL, {
      thread_ts: session.thread_ts,
      text: STRINGS.busyNotice.replace('{message}', message),
    });

    console.log(`⏱️ Auto-response sent for session ${sessionId}: "${message}"`);
  } catch (error) {
    console.error(`❌ Error sending auto-response for session ${sessionId}:`, error.message);
  }
}

// ============================================
// Redis Session Management
// ============================================

/**
 * Save a new session to Redis
 */
async function saveSession(sessionId, threadTs, profileName) {
  const session = {
    session_id: sessionId,
    thread_ts: threadTs,
    profile_name: profileName || 'Customer',
    created_at: new Date().toISOString(),
  };

  // Store by session ID
  await redis.set(`session:${sessionId}`, JSON.stringify(session));
  // Store reverse lookup by thread timestamp
  await redis.set(`thread:${threadTs}`, sessionId);

  return session;
}

/**
 * Get session by session ID
 */
async function getSession(sessionId) {
  const data = await redis.get(`session:${sessionId}`);
  return data ? JSON.parse(data) : null;
}

/**
 * Get session by Slack thread timestamp
 */
async function getSessionByThread(threadTs) {
  const sessionId = await redis.get(`thread:${threadTs}`);
  if (!sessionId) return null;
  return getSession(sessionId);
}

/**
 * Delete session from Redis
 */
async function deleteSession(sessionId, threadTs) {
  cancelAutoResponses(sessionId);
  await redis.del(`session:${sessionId}`);
  await redis.del(`thread:${threadTs}`);
}

// Start server
async function startServer() {
  await redis.connect();

  app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║     WhatsApp to Slack Integration Server                  ║
╠═══════════════════════════════════════════════════════════╣
║  Server running on port ${PORT}                              ║
║  AI Studio Region: ${AI_STUDIO_REGION.toUpperCase()}                                    ║
║  Redis: Connected                                         ║
╠═══════════════════════════════════════════════════════════╣
║  Endpoints:                                               ║
║  • POST /start         - AI Studio live agent start       ║
║  • POST /inbound       - AI Studio inbound messages       ║
║  • POST /slack/events  - Slack Events API                 ║
║  • POST /slack/interactions - Slack interactive buttons   ║
║  • POST /slack/assign  - Assignment slash command         ║
║  • GET  /health        - Health check                     ║
║  • GET  /contact/check - Check if contact exists          ║
╚═══════════════════════════════════════════════════════════╝
    `);
  });
}

startServer().catch(console.error);
