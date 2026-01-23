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

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

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

// Store active sessions - maps session_id to thread info
// In production, use Redis or a database
const SESSIONS = {};

// Middleware
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', sessions: Object.keys(SESSIONS).length });
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

    let messageText = `🆕 *New WhatsApp Support Request*\n\n`;
    messageText += `👤 *${profileName}*`;
    if (phoneNumber) messageText += ` (${phoneNumber})`;
    messageText += `\n`;
    if (initialMessage) messageText += `💬 "${initialMessage}"\n`;
    messageText += `\n✅ React with :white_check_mark: to close`;
    if (transcription) messageText += `\n\nTranscription:${transcription}`;
    messageText += `\n💬 Reply in this thread to respond`

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
    newSession(sessionId, threadTs);
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
    const session = SESSIONS[sessionId];

    if (!session) {
      console.warn('⚠️ No session found for:', sessionId);
      res.status(200).json({ status: 'warning', message: 'Session not found' });
      return;
    }

    let slackMessage;

    switch (messageType) {
      case 'image': {
        const imageCaption = req.body.image.caption ? `\n"${req.body.image.caption}"` : '';
        slackMessage = {
          thread_ts: session.thread_ts,
          text: `📱 *Customer sent an image:*${imageCaption}`,
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: `📱 *Customer sent an image:*${imageCaption}` }
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
          text: `📱 *Customer sent a video:*${videoCaption}\n${req.body.video.url}`
        };
        break;
      }

      default: // text
        slackMessage = {
          thread_ts: session.thread_ts,
          text: `📱 *Customer:*\n${req.body.text}`
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
  const session = findSessionByThread(threadTs);
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

    if (!['image', 'video'].includes(fileType)) {
      console.log(`⚠️ Unsupported file type: ${file.mimetype}`);
      await axios.post(SLACK_WEBHOOK_URL, {
        thread_ts: threadTs,
        text: `⚠️ Cannot send ${file.mimetype} files to WhatsApp. Only images and videos are supported.`,
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
    const uploadResult = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        { resource_type: fileType === 'video' ? 'video' : 'image' },
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
      text: `❌ Failed to send file to WhatsApp: ${error.message}`,
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
  const session = findSessionByThread(threadTs);
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
    text: `✅ *Ticket closed*`,
  });

  // Clean up session
  delete SESSIONS[session.session_id];
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
      const role = key === 'BOT' ? '🤖 Bot' : '👤 User';
      formatted += `\n${role}: ${message[key]}`;
    }
  }

  formatted += '\n```';
  return formatted;
}

/**
 * Create a new session mapping
 */
function newSession(sessionId, threadTs) {
  SESSIONS[sessionId] = {
    session_id: sessionId,
    thread_ts: threadTs,
    created_at: new Date().toISOString(),
  };
}

/**
 * Find session by Slack thread timestamp (reverse lookup)
 */
function findSessionByThread(threadTs) {
  for (const sessionId in SESSIONS) {
    if (SESSIONS[sessionId].thread_ts === threadTs) {
      return SESSIONS[sessionId];
    }
  }
  return null;
}

// Start server
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║     WhatsApp to Slack Integration Server                  ║
╠═══════════════════════════════════════════════════════════╣
║  Server running on port ${PORT}                              ║
║  AI Studio Region: ${AI_STUDIO_REGION.toUpperCase()}                                    ║
╠═══════════════════════════════════════════════════════════╣
║  Endpoints:                                               ║
║  • POST /start        - AI Studio live agent start        ║
║  • POST /inbound      - AI Studio inbound messages        ║
║  • POST /slack/events - Slack Events API                  ║
║  • GET  /health       - Health check                      ║
╚═══════════════════════════════════════════════════════════╝
  `);
});
