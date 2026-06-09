// agent-chat-guard.ts
// Bounded bot-to-bot conversation guards for the CalibrateRL Slack listener.
//
// Two guarantees:
//   1. READ-ONLY: when a bot is replying to ANOTHER bot, it gets no write/exec tools.
//      So even if bot A tells bot B "edit reward_func.py", B physically cannot.
//   2. HOP LIMIT: every bot-to-bot message carries a hidden [hop N/MAX] tag.
//      At the limit, the replying bot is stripped of the ability to tag another
//      bot, so the chain terminates. A human @mention always resets the counter.
//
// This is intentionally small and self-contained so it can be applied identically
// on gilbert / kathryne / charizard and removed cleanly.

export const MAX_HOPS = 4; // bot<->bot exchanges before the chain is force-ended

// Hidden marker we append to bot-to-bot messages. Humans don't type this; only
// bots emit it, so its presence is how we know a message came from "the chain".
const HOP_RE = /\[hop\s+(\d+)\/(\d+)\]/i;

// Read-only MCP/tool allowlist for bot-to-bot turns. Adjust to your server names.
// These let the bot read the repo + read Slack, but NOT write files, run bash
// that mutates, or push. (Claude Code's built-in Read/Grep/Glob are safe; we
// simply do NOT include Write/Edit/Bash in the allowlist, and we keep
// permissionMode strict so nothing unlisted runs.)
export const READONLY_ALLOWED_TOOLS = [
  'Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch',
  'mcp__slack__slack_get_channel_history',
  'mcp__slack__slack_list_channels',
  'mcp__slack__slack_get_user_profile',
  'mcp__slack__slack_get_users',
];

export interface ChainInfo {
  isFromBot: boolean;   // inbound message was authored by another bot
  hop: number;          // current hop number parsed from inbound (0 if none)
  atLimit: boolean;     // true if this turn is the last allowed hop
}

// Inspect an inbound Slack event. `botId` is event.bot_id (set by Slack when the
// author is a bot/app). `text` is the message body.
export function inspectInbound(botId: string | undefined, text: string | undefined): ChainInfo {
  const isFromBot = !!botId;
  let hop = 0;
  if (text) {
    const m = text.match(HOP_RE);
    if (m) hop = parseInt(m[1], 10) || 0;
  }
  const nextHop = hop + 1;
  return {
    isFromBot,
    hop,
    atLimit: nextHop >= MAX_HOPS,
  };
}

// Decide the tool options for this turn. Human turns => full tools (caller's
// default). Bot-to-bot turns => read-only allowlist, strict permission mode.
export function applyReadOnlyForBotTurn(options: any, chain: ChainInfo): any {
  if (!chain.isFromBot) return options; // human-addressed: leave full tools intact
  return {
    ...options,
    permissionMode: 'default',            // strict: only listed tools may run
    allowedTools: READONLY_ALLOWED_TOOLS, // no Write/Edit/Bash/git
    disallowedTools: ['Write', 'Edit', 'Bash', 'NotebookEdit'],
  };
}

// Post-process the bot's outgoing text before it goes to Slack on a bot-to-bot turn.
//   - stamps the next hop counter so the receiving bot can read it
//   - if at the limit, strips any <@BOTID> / @name mentions so the chain can't continue
export function stampOutgoing(text: string, chain: ChainInfo, botMentionRe: RegExp): string {
  if (!chain.isFromBot) return text; // human turn: don't stamp, don't strip
  const nextHop = chain.hop + 1;
  let out = text;
  if (chain.atLimit) {
    // Force-end: remove mentions so no other bot is triggered.
    out = out.replace(botMentionRe, '(chat limit reached — ending here)');
    out += `\n\n_[hop ${nextHop}/${MAX_HOPS} — chain ended]_`;
  } else {
    out += `\n\n_[hop ${nextHop}/${MAX_HOPS}]_`;
  }
  return out;
}
