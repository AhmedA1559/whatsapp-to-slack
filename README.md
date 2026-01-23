# WhatsApp to Slack Integration

A Node.js application that integrates **inbound WhatsApp messages** (via Vonage AI Studio) with **outbound Slack notifications**. This enables your team to respond to customer WhatsApp inquiries directly from Slack.

## Architecture

```
┌──────────────┐      ┌──────────────┐      ┌──────────────┐      ┌──────────────┐
│   Customer   │ ──── │   WhatsApp   │ ──── │  AI Studio   │ ──── │  This App    │
│  (WhatsApp)  │      │   (Vonage)   │      │  (Virtual    │      │  (Node.js)   │
└──────────────┘      └──────────────┘      │   Agent)     │      └──────┬───────┘
                                            └──────────────┘             │
                                                                         │
                                                                         ▼
                                                                  ┌──────────────┐
                                                                  │    Slack     │
                                                                  │  (Your Team) │
                                                                  └──────────────┘
```

## Flow

1. **Customer** sends a WhatsApp message
2. **AI Studio** virtual agent handles the initial conversation
3. If the customer types "escalate" (or triggers live agent routing), the conversation is transferred to a human
4. **This app** receives the handoff and posts to Slack with conversation history
5. **Agent** clicks "Start ticket" shortcut to link the conversation
6. **Agent** uses `/reply <session_id> <message>` to respond
7. **Customer** receives the response on WhatsApp
8. **Agent** uses `/close_ticket <session_id>` to end the conversation

## Prerequisites

- [Node.js](https://nodejs.org/) (v16+)
- [Vonage API Account](https://dashboard.nexmo.com/) with a WhatsApp-enabled number
- [Vonage AI Studio](https://studio.ai.vonage.com/) access
- Slack workspace with permission to install apps
- A way to expose your local server (ngrok, localtunnel, etc.)

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```env
SLACK_WEBHOOK_URL="https://hooks.slack.com/services/..."
AI_STUDIO_KEY="your-ai-studio-key"
AI_STUDIO_REGION="eu"  # or "us"
PORT=3000
```

### 3. Expose Your Server

Using localtunnel:
```bash
npx localtunnel --port 3000
```

Note your tunnel URL (e.g., `https://abc-xyz.loca.lt`) - you'll need this for Slack and AI Studio configuration.

### 4. Create Slack App

1. Go to [Slack API Apps](https://api.slack.com/apps)
2. Click **Create New App** > **From Scratch**
3. Name it (e.g., "WhatsApp Support") and select your workspace

#### Enable Incoming Webhooks
1. Navigate to **Incoming Webhooks** in the sidebar
2. Toggle **Activate Incoming Webhooks** to On
3. Click **Add New Webhook to Workspace**
4. Select your support channel
5. Copy the webhook URL to your `.env` file

#### Enable Interactivity (for shortcuts)
1. Navigate to **Interactivity & Shortcuts**
2. Toggle **Interactivity** to On
3. Set **Request URL** to: `YOUR_TUNNEL_URL/slack/start`
4. Save Changes

#### Create Message Shortcut
1. In **Interactivity & Shortcuts**, scroll to **Shortcuts**
2. Click **Create New Shortcut** > **On messages**
3. Configure:
   - **Name:** Start ticket
   - **Description:** Link this conversation for responses
   - **Callback ID:** `begin_response`
4. Save

#### Create Slash Commands
Navigate to **Slash Commands** and create:

**Reply Command:**
- **Command:** `/reply`
- **Request URL:** `YOUR_TUNNEL_URL/slack/message`
- **Description:** Reply to WhatsApp customer
- **Usage Hint:** `[session_id] [message]`

**Close Ticket Command:**
- **Command:** `/close_ticket`
- **Request URL:** `YOUR_TUNNEL_URL/slack/end`
- **Description:** Close support ticket
- **Usage Hint:** `[session_id]`

#### Install App
1. Navigate to **Install App**
2. Click **Install to Workspace**
3. Authorize the requested permissions

### 5. Configure AI Studio

1. Go to [AI Studio](https://studio.ai.vonage.com/)
2. Create a new **WhatsApp** agent (Inbound, Start From Scratch)
3. Build your conversation flow:
   - Add a **Collect Input** node to ask for the user's inquiry
   - Add a **Conditions** node to check if inquiry equals "escalate"
   - If escalate → **Send Message** ("Please hold...") → **Live Agent Routing**
   - Otherwise → handle normally → **End Conversation**

4. Configure the **Live Agent Routing** node:
   - **Start Connection EP:** `YOUR_TUNNEL_URL/start`
   - **Inbound Transfer EP:** `YOUR_TUNNEL_URL/inbound`
   - **Transfer Parameters:** Select any parameters you want passed through

5. Get your API key:
   - Click the user icon (top right)
   - Click **Generate API Key**
   - Copy to your `.env` file

6. Publish your agent and assign your WhatsApp number

## Running the Server

```bash
# Development
npm run dev

# Production
npm start
```

## Usage

### For Slack Agents

1. **When a new support request arrives:**
   - A message appears in your channel with session ID and conversation history
   - Click the message's **⋮** menu → **Start ticket**

2. **To reply to the customer:**
   ```
   /reply abc123-def-456 Hello! How can I help you today?
   ```

3. **To close the conversation:**
   ```
   /close_ticket abc123-def-456
   ```

### Slack Message Format

New conversations appear like:
```
🆕 New WhatsApp Support Request

Session: `abc12345-1234-5678-9abc-def012345678`
From: +1234567890

Transcription:
```
🤖 Bot: Welcome! How can I help?
👤 User: I need to speak to someone
🤖 Bot: Please hold while we connect you...
```
```

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/start` | POST | AI Studio live agent handoff |
| `/inbound` | POST | User messages during live session |
| `/slack/start` | POST | Slack shortcut handler |
| `/slack/message` | POST | Slack `/reply` command |
| `/slack/end` | POST | Slack `/close_ticket` command |
| `/health` | GET | Health check |

## Production Considerations

1. **Session Storage:** Replace the in-memory `SESSIONS` object with Redis or a database
2. **Error Handling:** Add more robust error handling and retry logic
3. **Authentication:** Verify Slack request signatures
4. **Logging:** Add structured logging for production monitoring
5. **HTTPS:** Use proper SSL certificates in production

## Troubleshooting

**Messages not appearing in Slack:**
- Verify `SLACK_WEBHOOK_URL` is correct
- Check that the webhook is enabled for your channel

**Can't send replies to WhatsApp:**
- Verify `AI_STUDIO_KEY` is correct
- Check `AI_STUDIO_REGION` matches your account region
- Ensure the session is still active in AI Studio

**Shortcut not working:**
- Verify the Request URL in Slack app settings
- Check that your tunnel is running

## License

MIT
