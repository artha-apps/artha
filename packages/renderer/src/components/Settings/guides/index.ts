/**
 * Settings panel guide content — one entry per high-friction panel.
 *
 * Voice: plain English. Skip jargon ("embeddings", "vector search", "OAuth")
 * unless absolutely necessary; if used, explain inline. The "dumb user" test
 * is: a non-developer who has never read AI docs should know what to do after
 * reading three short bullets.
 *
 * To add a new guide:
 *   1. Add an entry to `GUIDES` below.
 *   2. In the matching panel component, import + mount:
 *        <FeatureGuide {...GUIDES.yourkey} />
 *      plus a <GuideReopenButton featureKey="yourkey" /> in the panel header.
 *   3. Add the same `tip` copy to the matching Sidebar nav row for consistency.
 */

export interface GuideContent {
  featureKey: string;
  title: string;
  summary: string;
  bullets: string[];
  steps: string[];
  learnMoreUrl?: string;
}

export const GUIDES = {
  rag: {
    featureKey: 'rag',
    title: 'RAG indexes',
    summary:
      'Give the agent searchable access to a folder on your machine — no cloud, no upload.',
    bullets: [
      'The agent can read, cite, and answer questions about files in folders you index.',
      'Indexes live entirely on your machine. Re-indexing only touches files that changed.',
      'Use the /ask skill in chat to search the indexed content.',
    ],
    steps: [
      'Click "+ New index" below and pick a folder (Documents, a project folder, etc.).',
      'Wait for the index to build — small folders take seconds, large ones a few minutes.',
      'In a chat, type "/ask what is X?" and the agent will search the index and cite the files it used.',
    ],
  },
  mcp: {
    featureKey: 'mcp',
    title: 'MCP tools',
    summary:
      'Plug external tools into the agent. MCP (Model Context Protocol) is a standard for tool servers — Slack, GitHub, Postgres, and many more are available.',
    bullets: [
      'Each MCP server gives the agent a new set of skills (e.g. "send a Slack message", "query Postgres").',
      'The Marketplace tab below lists installable servers with one-click setup.',
      'You can also paste a server command directly if you have one already.',
    ],
    steps: [
      'Open the Marketplace tab and browse the curated list.',
      'Pick a server, click Install — it sets up everything for you.',
      'Toggle it on. The agent can now use those tools in any chat.',
    ],
  },
  router: {
    featureKey: 'router',
    title: 'Router',
    summary:
      'Decide which model handles which kind of task. Heavy reasoning to a big model, quick replies to a fast one.',
    bullets: [
      'Rules match on the kind of work (code, long writing, quick chat) and pick a model.',
      'No rules = the agent uses your default model for everything.',
      'Useful when you have several models installed and want to save tokens / time.',
    ],
    steps: [
      'Add a rule like "If task involves code, use llama3.1:70b".',
      'Add a fallback rule, e.g. "For everything else, use llama3.2:3b".',
      'Send a chat to see the router pick the model — the chosen model appears in the execution log.',
    ],
  },
  memory: {
    featureKey: 'memory',
    title: 'Memory',
    summary:
      'Long-term facts the agent remembers across every conversation — your preferences, projects, decisions.',
    bullets: [
      'Tell the agent "remember that X" in any chat and it shows up here.',
      'Memories are scoped: some apply to all chats, some only to a specific project.',
      'You can edit, pin, or delete any memory from this panel.',
    ],
    steps: [
      'In a chat, say "Remember that my preferred document style is APA."',
      'Come back here — the new memory appears in the list.',
      'Start a new chat and ask "What\'s my preferred document style?" — the agent will know.',
    ],
  },
  skills: {
    featureKey: 'skills',
    title: 'Skills',
    summary:
      'Named playbooks the agent picks automatically. Each skill is a focused mode: research, writing, organizing, etc.',
    bullets: [
      'Type "/" in the chat composer to see all available skills.',
      'The agent auto-matches a skill to your request if you don\'t pick one.',
      'You can create custom skills with their own instructions and tool allowlist.',
    ],
    steps: [
      'Open a built-in skill (e.g. "Research") and read its instructions.',
      'In a chat, type "/research summarize the news today" and watch the agent follow the playbook.',
      'Click "+ New skill" to write your own — give it a slug, instructions, and the tools it can use.',
    ],
  },
  cloud: {
    featureKey: 'cloud',
    title: 'Cloud integrations',
    summary:
      'Bring your Google, Notion, GitHub, and other accounts into Artha so the agent can read and act on them.',
    bullets: [
      'Each integration is a one-time OAuth login. Tokens are stored only on your machine.',
      'Connected services appear as tools the agent can use in any chat.',
      'You can revoke an integration any time — Artha forgets the token immediately.',
    ],
    steps: [
      'Pick a service from the list below (e.g. Google Drive).',
      'Sign in through the browser window that opens.',
      'In a chat, ask "What files do I have in Drive?" — the agent will use the new connection.',
    ],
  },
  ide: {
    featureKey: 'ide',
    title: 'IDE integration',
    summary:
      'Connect Artha to your editor so the agent can read your code and you can run it on highlighted snippets.',
    bullets: [
      'Currently supports VS Code via a small extension.',
      'Lets the agent see your open files and project structure (when you allow it).',
      'You can run a chat from inside the editor without switching apps.',
    ],
    steps: [
      'Copy the setup snippet below.',
      'Paste it into your VS Code settings or extension config as instructed.',
      'Reload VS Code — Artha appears in the sidebar.',
    ],
  },
  marketplace: {
    featureKey: 'marketplace',
    title: 'Marketplace',
    summary:
      'Browse and install community-built skill packs and bundles — pre-tuned playbooks for common workflows.',
    bullets: [
      'Skill packs add new specialized skills (e.g. "investment-research", "cold-email-writer").',
      'Bundles are saved end-to-end workflows you can replay against your own data.',
      'Different from MCP Tools: those add raw capabilities, this adds curated playbooks.',
    ],
    steps: [
      'Browse the list and read a description.',
      'Click Install to add it to your local Skills.',
      'Use it in chat with "/skill-slug your prompt".',
    ],
  },
} satisfies Record<string, GuideContent>;

export type GuideKey = keyof typeof GUIDES;
