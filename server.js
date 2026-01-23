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
 * 3. New conversation appears in Slack channel
 * 4. Agent clicks shortcut to "open ticket" → links thread to session
 * 5. Agent uses /reply command → message sent to WhatsApp user
 * 6. User responses → forwarded to Slack thread via /inbound
 * 7. Agent uses /close_ticket → conversation ends
 */

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 3000;

// Environment variables
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const AI_STUDIO_KEY = process.env.AI_STUDIO_KEY;
const AI_STUDIO_REGION = process.env.AI_STUDIO_REGION || 'eu'; // 'eu' or 'us'

// AI Studio API base URL based on region
const AI_STUDIO_BASE_URL = `https://studio-api-${AI_STUDIO_REGION}.ai.vonage.com`;

// Store active sessions - maps session_id to thread info
// In production, use Redis or a database
const SESSIONS = {};

// Middleware
app.use(express.json());
const urlencodedParser = bodyParser.urlencoded({ extended: false });

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
    const userNumber = req.body.sender || 'Unknown';
    
    const data = {
      text: `🆕 *New WhatsApp Support Request*\n\nSession: \`${sessionId}\`\nFrom: ${userNumber}\n\nTranscription:${transcription || '\n_No previous messages_'}`,
    };

    await axios.post(SLACK_WEBHOOK_URL, data);
    console.log('✅ Conversation initiated in Slack');
    
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
 */
app.post('/inbound', async (req, res) => {
  try {
    console.log('📥 Inbound message received:', JSON.stringify(req.body, null, 2));
    
    const message = req.body.text;
    const sessionId = req.body.sessionId;
    const session = SESSIONS[sessionId];

    if (!session) {
      console.warn('⚠️ No session found for:', sessionId);
      // Still acknowledge the message but log the issue
      res.status(200).json({ status: 'warning', message: 'Session not found - message may not be threaded' });
      return;
    }

    const data = {
      thread_ts: session.thread_ts,
      text: `📱 *Customer:*\n\`\`\`${message}\`\`\``,
    };

    await axios.post(SLACK_WEBHOOK_URL, data);
    console.log('✅ User message forwarded to Slack thread');
    
    res.status(200).json({ status: 'success' });
  } catch (error) {
    console.error('❌ Error in /inbound:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * /slack/start - Slack shortcut to "open a ticket"
 * 
 * When an agent clicks the message shortcut, this links the Slack thread
 * to the AI Studio session for proper message routing.
 */
app.post('/slack/start', urlencodedParser, async (req, res) => {
  try {
    // Acknowledge immediately to prevent Slack timeout
    res.status(200).send('');
    
    const payload = JSON.parse(req.body.payload);
    console.log('📥 Slack shortcut triggered:', payload.callback_id);
    
    const threadTs = payload.message.ts;
    const sessionId = extractSessionId(payload.message.text);
    
    if (!sessionId) {
      console.error('❌ Could not extract session ID from message');
      return;
    }

    // Create session mapping
    newSession(sessionId, threadTs);
    console.log(`✅ Session ${sessionId} linked to thread ${threadTs}`);

    // Confirm in thread
    const data = {
      thread_ts: threadTs,
      text: `✅ Ticket opened by <@${payload.user.id}>\n\nUse \`/reply ${sessionId} [your message]\` to respond\nUse \`/close_ticket ${sessionId}\` when resolved`,
    };

    await axios.post(SLACK_WEBHOOK_URL, data);
  } catch (error) {
    console.error('❌ Error in /slack/start:', error.message);
  }
});

/**
 * /slack/message - Slash command to send reply to WhatsApp user
 * 
 * Usage: /reply <session_id> <message>
 */
app.post('/slack/message', urlencodedParser, async (req, res) => {
  try {
    console.log('📥 Reply command received:', req.body);
    
    const parsed = parseMessage(req.body.text);
    const sessionId = parsed.sessionId;
    const message = parsed.message;

    if (!sessionId || !message) {
      res.status(200).json({
        response_type: 'ephemeral',
        text: '❌ Usage: /reply <session_id> <your message>',
      });
      return;
    }

    const session = SESSIONS[sessionId];
    if (!session) {
      res.status(200).json({
        response_type: 'ephemeral',
        text: `❌ Session \`${sessionId}\` not found. Make sure to click the "Start ticket" shortcut first.`,
      });
      return;
    }

    // Send to AI Studio (which forwards to WhatsApp)
    const studioData = { 
      message_type: 'text', 
      text: message 
    };

    await axios.post(
      `${AI_STUDIO_BASE_URL}/live-agent/outbound/${sessionId}`,
      studioData,
      { headers: { 'X-Vgai-Key': AI_STUDIO_KEY } }
    );

    // Post confirmation in Slack thread
    const slackData = {
      thread_ts: session.thread_ts,
      text: `💬 *Agent <@${req.body.user_id}>:*\n\`\`\`${message}\`\`\``,
    };

    await axios.post(SLACK_WEBHOOK_URL, slackData);
    console.log('✅ Reply sent to WhatsApp user');

    res.status(200).json({
      response_type: 'ephemeral',
      text: '✅ Message sent!',
    });
  } catch (error) {
    console.error('❌ Error in /slack/message:', error.message);
    res.status(200).json({
      response_type: 'ephemeral',
      text: `❌ Error: ${error.message}`,
    });
  }
});

/**
 * /slack/end - Slash command to close a support ticket
 * 
 * Usage: /close_ticket <session_id>
 */
app.post('/slack/end', urlencodedParser, async (req, res) => {
  try {
    console.log('📥 Close ticket command received:', req.body);
    
    const parsed = parseMessage(req.body.text);
    const sessionId = parsed.sessionId || parsed.message; // Handle case where only session_id is provided

    if (!sessionId) {
      res.status(200).json({
        response_type: 'ephemeral',
        text: '❌ Usage: /close_ticket <session_id>',
      });
      return;
    }

    const session = SESSIONS[sessionId];
    if (!session) {
      res.status(200).json({
        response_type: 'ephemeral',
        text: `❌ Session \`${sessionId}\` not found.`,
      });
      return;
    }

    // Tell AI Studio to end the conversation
    await axios.post(
      `${AI_STUDIO_BASE_URL}/live-agent/disconnect/${sessionId}`,
      {},
      { headers: { 'X-Vgai-Key': AI_STUDIO_KEY } }
    );

    // Post closure message in Slack thread
    const slackData = {
      thread_ts: session.thread_ts,
      text: `✅ *Ticket closed by <@${req.body.user_id}>*\n\nThis conversation has been marked as resolved.`,
    };

    await axios.post(SLACK_WEBHOOK_URL, slackData);
    
    // Clean up session
    delete SESSIONS[sessionId];
    console.log(`✅ Session ${sessionId} closed`);

    res.status(200).json({
      response_type: 'ephemeral',
      text: '✅ Ticket closed successfully!',
    });
  } catch (error) {
    console.error('❌ Error in /slack/end:', error.message);
    res.status(200).json({
      response_type: 'ephemeral',
      text: `❌ Error: ${error.message}`,
    });
  }
});

// ============================================
// Helper Functions
// ============================================

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
 * Extract session ID from Slack message text
 */
function extractSessionId(input) {
  // Match UUID format in backticks
  const sessionIdPattern = /Session: `([0-9a-f-]{36})`/i;
  const match = input.match(sessionIdPattern);
  
  if (match && match[1]) {
    return match[1];
  }
  return null;
}

/**
 * Parse slash command input to extract session ID and message
 */
function parseMessage(input) {
  if (!input) return { message: '' };
  
  const parts = input.trim().split(' ');
  const potentialSessionId = parts[0];
  
  // UUID pattern
  const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  
  if (sessionIdPattern.test(potentialSessionId)) {
    return {
      sessionId: potentialSessionId,
      message: parts.slice(1).join(' '),
    };
  }
  
  return { message: input };
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
║  • POST /start     - AI Studio live agent start           ║
║  • POST /inbound   - AI Studio inbound messages           ║
║  • POST /slack/start   - Slack shortcut handler           ║
║  • POST /slack/message - Slack /reply command             ║
║  • POST /slack/end     - Slack /close_ticket command      ║
║  • GET  /health        - Health check                     ║
╚═══════════════════════════════════════════════════════════╝
  `);
});
