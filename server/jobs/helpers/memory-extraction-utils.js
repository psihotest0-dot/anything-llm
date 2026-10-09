const { WorkspaceChats } = require("../../models/workspaceChats.js");
const { safeJsonParse } = require("../../utils/http/index.js");
const { getBaseLLMProviderModel } = require("../../utils/helpers/index.js");
const AIbitat = require("../../utils/agents/aibitat/index.js");
const truncate = require("truncate");

// Cap per-group chat review so a long-dormant user can't trigger a 500-chat summarization.
const CHATS_PER_RUN_LIMIT = 20;

// Per-message cap — we keep 20 chats of context but truncate each prompt/response
// so a single huge message doesn't blow the LLM's context window.
const MAX_CHARS_PER_MESSAGE = 1500;

const SUMMARY_SYSTEM_PROMPT = `You are an expert conversation summarizer for a personalized AI assistant. Your job is to create a single comprehensive paragraph summarizing the recent conversation and capturing any important preferences, goals, or facts about the user.

You will be shown recent conversations between a user and an AI assistant.

RULES:
- Produce exactly one paragraph.
- Focus on actionable information: the user's name, role, goals, preferences, technical background, and constraints.
- Summarize the main topics discussed.
- Skip generic pleasantries, emotional states, or information solely originating from the assistant.
- If the conversation contains nothing substantive to remember, return an empty string.

When finished, you MUST call the save-summary tool with your generated summary paragraph.`;

/**
 * Group chats by (user_id, workspaceId).
 * @param {object[]} chats
 * @returns {Map<string, object[]>}
 */
function groupByUserWorkspace(chats) {
  const groups = new Map();
  for (const chat of chats) {
    const key = `${chat.user_id}:${chat.workspaceId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(chat);
  }
  return groups;
}

/**
 * Requery at summarize time so we reflect the current state (new chats, deletions).
 * Drop chats that died mid-stream / are pending, then reverse to chronological order.
 * @returns {Promise<object[]>}
 */
async function loadLatestChats(userId, workspaceId) {
  const latest = await WorkspaceChats.where(
    { user_id: userId, workspaceId, include: true },
    CHATS_PER_RUN_LIMIT,
    { createdAt: "desc" }
  );
  return latest
    .filter((c) => {
      const parsed = safeJsonParse(c.response);
      return typeof parsed?.text === "string" && parsed.text.length > 0;
    })
    .reverse();
}

/**
 * Pick a provider/model: workspace chat → workspace agent → system default.
 * @returns {{provider: string, model: string}|null}
 */
function resolveLLM(workspace) {
  if (workspace.chatProvider && workspace.chatModel)
    return { provider: workspace.chatProvider, model: workspace.chatModel };
  if (workspace.agentProvider && workspace.agentModel)
    return { provider: workspace.agentProvider, model: workspace.agentModel };
  const provider = process.env.LLM_PROVIDER;
  const model = provider ? getBaseLLMProviderModel({ provider }) : null;
  if (provider && model) return { provider, model };
  return null;
}

// ── Summary Generation ────────────────────────────────────────────────

function buildSummarizerUserMessage(chats) {
  const formattedChats = chats
    .map((chat) => {
      const lines = [`User: ${truncate(chat.prompt, MAX_CHARS_PER_MESSAGE)}`];
      const parsed = safeJsonParse(chat.response);
      if (parsed?.text)
        lines.push(
          `Assistant: ${truncate(parsed.text, MAX_CHARS_PER_MESSAGE)}`
        );
      return lines.join("\n");
    })
    .join("\n\n");

  return `Recent conversations to summarize:\n${formattedChats}`;
}

/**
 * Summarizer agent — extracts a single paragraph summary from conversations.
 * Returns {summary, rawText} where summary is a string (or null),
 * and rawText is whatever the model said (for debugging).
 */
async function runSummarizer({ provider, model, userMessage }) {
  let summary = null;
  let rawText = "";
  const aibitat = new AIbitat({ provider, model, maxRounds: 3 });

  aibitat.onMessage((msg) => {
    if (msg.from === "SUMMARIZER" && msg.content) rawText = msg.content;
  });

  aibitat
    .function({
      name: "save-summary",
      description: "Save the generated summary paragraph. Provide an empty string if there is nothing worth remembering.",
      parameters: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "A single paragraph summarizing the conversation.",
          },
        },
        required: ["summary"],
        additionalProperties: false,
      },
      handler: function (args) {
        summary = typeof args.summary === "string" ? args.summary.trim() : null;
        aibitat.skipHandleExecution = true;
        return "Summary saved.";
      },
    })
    .agent("USER", { role: "Provides conversations for summarization." })
    .agent("SUMMARIZER", {
      role: SUMMARY_SYSTEM_PROMPT,
      functions: ["save-summary"],
    });

  await aibitat.start({
    from: "USER",
    to: "SUMMARIZER",
    content: userMessage,
  });

  return { summary, rawText };
}

module.exports = {
  groupByUserWorkspace,
  loadLatestChats,
  resolveLLM,
  buildSummarizerUserMessage,
  runSummarizer,
};
