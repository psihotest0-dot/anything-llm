const { log, conclude } = require("./helpers/index.js");
const { SystemSettings } = require("../models/systemSettings.js");
const { Memory } = require("../models/memory.js");
const { WorkspaceChats } = require("../models/workspaceChats.js");
const { Workspace } = require("../models/workspace.js");
const { Document } = require("../models/documents.js");
const { CollectorApi } = require("../utils/collectorApi/index.js");
const truncate = require("truncate");
const {
  groupByUserWorkspace,
  loadLatestChats,
  resolveLLM,
  buildSummarizerUserMessage,
  runSummarizer,
} = require("./helpers/memory-extraction-utils.js");

// 20 minutes default; 0 disables the idle check.
const IDLE_THRESHOLD_MS = Number(
  process.env.MEMORY_IDLE_THRESHOLD_MS ?? 20 * 60 * 1000
);

// Minimum chats required before processing memories for a user/workspace pair.
const MIN_CHATS_TO_PROCESS = 5;

(async () => {
  try {
    if (!(await SystemSettings.autoMemoriesEnabled())) {
      log("Automatic memory extraction is disabled. Exiting.");
      return;
    }

    // Discover (user, workspace) groups with unprocessed visible chats.
    // include:true filters out chats deleted via /reset — they must never be summarized.
    const allUnprocessed = await WorkspaceChats.where(
      { memoryProcessed: null, include: true },
      null,
      { createdAt: "asc" }
    );
    if (allUnprocessed.length === 0) {
      log("No unprocessed chats found. Exiting.");
      return;
    }

    const groups = groupByUserWorkspace(allUnprocessed);
    log(`Found ${groups.size} user/workspace pair(s) with unprocessed chats.`);

    for (const group of groups.values()) await processGroup(group);

    log("Memory extraction complete.");
  } catch (e) {
    console.error(e);
    log(`errored with ${e.message}`);
  } finally {
    conclude();
  }
})();

/**
 * Process a single (user, workspace) group via summarization:
 *   Extract a single summary paragraph of the recent conversation and
 *   vectorize it directly into the workspace's documents.
 * Then mark all chats as processed.
 * @param {object[]} groupChats - chats for this group, sorted asc.
 */
async function processGroup(groupChats) {
  const { user_id: userId, workspaceId } = groupChats[0];
  const tag = `user ${userId}, workspace ${workspaceId}`;

  if (groupChats.length < MIN_CHATS_TO_PROCESS) {
    log(
      `${tag} has only ${groupChats.length} chat(s). Need at least ${MIN_CHATS_TO_PROCESS}. Skipping.`
    );
    return;
  }

  if (isGroupActive(groupChats)) {
    log(`${tag} is still active. Skipping.`);
    return;
  }

  const unprocessedIds = groupChats.map((c) => c.id);
  try {
    const workspace = await Workspace.get({ id: workspaceId });
    if (!workspace) {
      log(`Workspace ${workspaceId} not found. Marking processed.`);
      return;
    }

    const chats = await loadLatestChats(userId, workspaceId);
    if (chats.length === 0) {
      log(`No summarizable chats for ${tag}. Marking processed.`);
      return;
    }

    const llm = resolveLLM(workspace);
    if (!llm) {
      log(`No LLM configured for workspace ${workspaceId}. Marking processed.`);
      return;
    }

    log(
      `Running Summarizer for ${tag} using ${llm.provider}/${llm.model} on ${chats.length} chat(s).`
    );
    const summarizerMessage = buildSummarizerUserMessage(chats);
    const { summary, rawText } = await runSummarizer({
      ...llm,
      userMessage: summarizerMessage,
    });

    if (!summary || summary.trim().length === 0) {
      log(`Summarizer produced no summary for ${tag}.`);
      if (rawText)
        log(`Summarizer raw response:\n${truncate(rawText, 2000)}`);
      return;
    }

    log(`Summarizer produced summary for ${tag}:\n"${summary}"`);

    const collector = new CollectorApi();
    const result = await collector.processRawText(summary, {
      title: `Conversation Summary ${new Date().toLocaleString()}`,
      docAuthor: "AnythingLLM Memory Extraction",
      description: "Auto-generated summary of recent conversation.",
    });

    if (!result.success || !result.documents || result.documents.length === 0) {
      log(`Failed to process summary text into a document for ${tag}: ${result.reason}`);
      return;
    }

    const locations = result.documents.map((d) => d.location).filter(Boolean);
    if (locations.length > 0) {
      const { failedToEmbed, errors } = await Document.addDocuments(workspace, locations, userId);
      if (failedToEmbed.length > 0) {
        log(`Failed to embed summary document into workspace ${workspace.name}: ${Array.from(errors).join(", ")}`);
      } else {
        log(`Successfully embedded summary document into workspace ${workspace.name}.`);
      }
    }
  } catch (error) {
    log(`Error processing ${tag}: ${error.message}`);
  } finally {
    await WorkspaceChats.markMemoryProcessed(unprocessedIds);
  }
}

/**
 * True if the user has chatted too recently for extraction to be safe.
 * Chats are sorted asc, so the last element is the most recent.
 */
function isGroupActive(groupChats) {
  const last = groupChats[groupChats.length - 1];
  return Date.now() - new Date(last.createdAt).getTime() < IDLE_THRESHOLD_MS;
}
