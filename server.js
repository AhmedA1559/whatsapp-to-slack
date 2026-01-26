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
 * 6. Agent reacts with ✅ → conversation ends
 */

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cloudinary = require('cloudinary').v2;
const { createClient } = require('redis');

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

// ============================================
// Translatable Strings
// ============================================
const STRINGS = {
  // New ticket message
  newRequest: '🆕 *New WhatsApp Support Request*',
  reactToClose: '✅ React with :white_check_mark: to close',
  replyInThread: '💬 Reply in this thread to respond',
  transcriptionHeader: 'Transcription:',
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

  // Transcription roles
  botRole: '🤖 Bot',
  userRole: '👤 User',

  assignedTo: '👋 Assigned to'
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
 * /start - Called by AI Studio when live agent routing begins
 *
 * This endpoint is triggered when a WhatsApp user requests human support.
 * It creates a new message in Slack with the conversation history.
 */
app.post('/start', async (req, res) => {
  try {
    console.log('📥 Start endpoint received:', JSON.stringify(req.body, null, 2));

    const sessionId = req.body.sessionId;
    const transcription = handleTranscription(req.body.history?.transcription);

    // Extract parameters from history
    const params = extractParameters(req.body.history?.parameters);
    const profileName = params.PROFILE_NAME || 'Unknown';
    const phoneNumber = params.SENDER_PHONE_NUMBER || '';
    const initialMessage = params.INITIAL_MESSAGE || '';
    const intent = params['USER.intent'] || '';
    const school = params['USER.school'] || '';

    // Format intent and school
    const intentType = STRINGS.intentTypes[intent] || intent;
    const schoolType = STRINGS.schoolTypes[school] || school;

    // Look up assigned user
    const assigneeId = await getAssignee(school, intent);

    let messageText = `${STRINGS.newRequest}\n\n`;
    messageText += `👤 *${profileName}*`;
    if (phoneNumber) messageText += ` (${phoneNumber})`;
    messageText += `\n`;
    if (intentType) messageText += `${intentType}`;
    if (intentType && schoolType) messageText += ` • `;
    if (schoolType) messageText += `${schoolType}`;
    if (intentType || schoolType) messageText += `\n`;
    if (assigneeId) messageText += `\n${STRINGS.assignedTo} <@${assigneeId}>\n`;
    if (initialMessage) messageText += `💬 "${initialMessage}"\n`;
    messageText += `\n${STRINGS.reactToClose}`;
    if (transcription) messageText += `\n\n${STRINGS.transcriptionHeader}${transcription}`;
    messageText += `\n${STRINGS.replyInThread}`;

    // Use Slack API to get the message timestamp for threading
    const response = await axios.post(
      'https://slack.com/api/chat.postMessage',
      {
        channel: SLACK_CHANNEL_ID,
        text: messageText,
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
    await saveSession(sessionId, threadTs);
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

    let slackMessage;

    switch (messageType) {
      case 'image': {
        const imageCaption = req.body.image.caption ? `\n"${req.body.image.caption}"` : '';
        slackMessage = {
          thread_ts: session.thread_ts,
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
          thread_ts: session.thread_ts,
          text: `${STRINGS.customerVideo}${videoCaption}\n${req.body.video.url}`
        };
        break;
      }

      case 'audio': {
        slackMessage = {
          thread_ts: session.thread_ts,
          text: `${STRINGS.customerAudio}\n🎵 ${req.body.audio.url}`
        };
        break;
      }

      default: // text
        slackMessage = {
          thread_ts: session.thread_ts,
          text: `${STRINGS.customerText}\n${req.body.text}`
        };
    }

    await axios.post(SLACK_WEBHOOK_URL, slackMessage);
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
          `• \`/assign <school> <intent> @user\` - Assign a user\n` +
          `• \`/assign list\` - Show all assignments\n` +
          `• \`/assign clear <school> <intent>\` - Remove assignment\n` +
          `• \`/assign help\` - Show this help\n\n` +
          `*Schools:* \`academy\`, \`daycare\`\n` +
          `*Intents:* \`registration\`, \`payment\`, \`inquiry\`\n\n` +
          `*Examples:*\n` +
          `• \`/assign academy registration @john\`\n` +
          `• \`/assign daycare payment @jane\``,
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
      for (const [key, userId] of Object.entries(assignments)) {
        const [school, intent] = key.split(':');
        const schoolLabel = STRINGS.schoolTypes[school] || school;
        const intentLabel = STRINGS.intentTypes[intent] || intent;
        response += `• ${schoolLabel} + ${intentLabel} → <@${userId}>\n`;
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
          text: '❌ Usage: `/assign clear <school> <intent>`\nExample: `/assign clear academy registration`\n\nType `/assign help` for more info.',
        });
      }

      await redis.del(`assign:${school}:${userType}`);
      return res.json({
        response_type: 'in_channel',
        text: `✅ Cleared assignment for ${school} + ${userType}`,
      });
    }

    // Create an assignment: /assign <school> <intent> @user
    const school = parts[0]?.toLowerCase();
    const userType = parts[1]?.toLowerCase();

    if (!school || !userType) {
      return res.json({
        response_type: 'ephemeral',
        text: '❌ Usage: `/assign <school> <intent> @user`\nExample: `/assign academy registration @john`\n\nType `/assign help` for more info.',
      });
    }

    // Extract user ID from mention
    let userId;

    // Try formatted mention first: <@U123456> or <@U123456|display name>
    const formattedMatch = text.match(/<@([A-Z0-9]+)(\|[^>]+)?>/i);
    if (formattedMatch) {
      userId = formattedMatch[1];
    } else {
      // Try plain @username format
      const plainMatch = text.match(/@(\S+)/);
      if (!plainMatch) {
        return res.json({
          response_type: 'ephemeral',
          text: '❌ Please mention a user with @username\nExample: `/assign academy registration @john`',
        });
      }

      // Look up user by username via Slack API
      const username = plainMatch[1];
      try {
        const lookupResponse = await axios.get(
          `https://slack.com/api/users.list`,
          { headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}` } }
        );

        if (!lookupResponse.data.ok) {
          throw new Error(lookupResponse.data.error);
        }

        const user = lookupResponse.data.members.find(
          m => m.name === username ||
               m.profile?.display_name?.toLowerCase() === username.toLowerCase() ||
               m.real_name?.toLowerCase() === username.toLowerCase()
        );

        if (!user) {
          return res.json({
            response_type: 'ephemeral',
            text: `❌ User "${username}" not found. Make sure to use their Slack username.`,
          });
        }

        userId = user.id;
      } catch (err) {
        return res.json({
          response_type: 'ephemeral',
          text: `❌ Error looking up user: ${err.message}`,
        });
      }
    }
    await redis.set(`assign:${school}:${userType}`, userId);

    const schoolLabel = STRINGS.schoolTypes[school] || school;
    const userTypeLabel = STRINGS.userTypes[userType] || userType;

    return res.json({
      response_type: 'in_channel',
      text: `✅ Assigned <@${userId}> to handle ${schoolLabel} + ${userTypeLabel} tickets`,
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
 * - ✅ reactions → closes the ticket
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

    // Handle reaction added (for closing tickets)
    if (event.type === 'reaction_added') {
      await handleReaction(event);
      return;
    }

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

/**
 * Handle reaction events - close ticket on ✅
 */
async function handleReaction(event) {
  // Only handle white_check_mark emoji
  if (event.reaction !== 'white_check_mark') {
    return;
  }

  // The reaction must be on the parent message (thread starter)
  const threadTs = event.item.ts;

  // Find session by thread
  const session = await getSessionByThread(threadTs);
  if (!session) {
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
    thread_ts: threadTs,
    text: STRINGS.ticketClosed,
  });

  // Clean up session from Redis
  await deleteSession(session.session_id, threadTs);
  console.log(`✅ Session ${session.session_id} closed`);
}

// ============================================
// Helper Functions
// ============================================

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

/**
 * Format transcription history for Slack display
 */
function handleTranscription(transcription = []) {
  if (!transcription || !transcription.length) return null;

  let formatted = '\n```';

  for (const message of transcription) {
    for (const key in message) {
      const keyUpper = key.toUpperCase();
      const isBot = keyUpper === 'BOT' || keyUpper === 'AGENT' || keyUpper === 'ASSISTANT';
      const role = isBot ? STRINGS.botRole : STRINGS.userRole;
      formatted += `\n${role}: ${message[key]}`;
    }
  }

  formatted += '\n```';
  return formatted;
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
    const userId = await redis.get(key);
    const shortKey = key.replace('assign:', '');
    assignments[shortKey] = userId;
  }

  return assignments;
}

/**
 * Get assignee for a school/userType combination
 */
async function getAssignee(school, userType) {
  if (!school && !userType) return null;

  // Try exact match first
  if (school && userType) {
    const exact = await redis.get(`assign:${school}:${userType}`);
    if (exact) return exact;
  }

  // Try school-only match
  if (school) {
    const schoolOnly = await redis.get(`assign:${school}:*`);
    if (schoolOnly) return schoolOnly;
  }

  // Try userType-only match
  if (userType) {
    const userTypeOnly = await redis.get(`assign:*:${userType}`);
    if (userTypeOnly) return userTypeOnly;
  }

  return null;
}

// ============================================
// Redis Session Management
// ============================================

/**
 * Save a new session to Redis
 */
async function saveSession(sessionId, threadTs) {
  const session = {
    session_id: sessionId,
    thread_ts: threadTs,
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
║  • POST /slack/assign  - Assignment slash command         ║
║  • GET  /health        - Health check                     ║
╚═══════════════════════════════════════════════════════════╝
    `);
  });
}

startServer().catch(console.error);
