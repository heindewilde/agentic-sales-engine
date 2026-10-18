/**
 * The process the agent map draws: every step, every block in it (who does what), and per block what it uses and
 * produces. Which files a block reads is NOT listed here: it's derived from the skill and agent text (src/app/brain.ts),
 * so it can't drift. Keep the blocks in step with the skills when a workflow changes.
 */

export interface Block {
  id: string;
  by: string; // "you", "operator" or a plugin agent name
  label: string;
  detail: string;
  skills?: string[]; // the playbooks this block follows
  runIn?: string[]; // runs of these skills show this block at work (default: skills)
  agent?: string; // the agent whose instructions apply (operator blocks: the operator)
  gate?: boolean; // a decision only you make
  uses?: string[]; // context beyond what the text names: "ase-context" (the digest), "evidence-pack", "web"
  tools?: string[];
  writes?: string[]; // workspace patterns
  example?: string; // a workspace pattern whose newest file shows a real output
  check?: string[]; // gates: what you look at
}

export interface Step {
  n: number | string;
  id: string;
  short: string;
  title: string;
  stage?: string; // the account stage this step brings companies to
  parallel?: boolean; // blocks run side by side, not one after another
  blocks: Block[];
}

export const PROCESS: Step[] = [
  {
    n: 0, id: "icp", short: "ICP", title: "Decide who you sell to",
    blocks: [
      { id: "icp-research", by: "icp-analyst", agent: "icp-analyst", skills: ["icp"], label: "Studies your site and best customers", detail: "Researches your own company and each customer you name, and returns cited traits: industry, size, model, ownership, triggers.", tools: ["web search", "fetch pages", "extract"], uses: ["web"], writes: ["icps/*/calibration/research/*.md"], example: "icps/*/calibration/research/*.md" },
      { id: "icp-draft", by: "operator", agent: "operator", skills: ["icp"], label: "Drafts ICP and scoring model", detail: "Turns the common traits into a profile, asks only about the gaps, and builds a scoring model tested against your known customers.", writes: ["icps/*/icp.md", "icps/*/scoring.yaml"], example: "icps/*/scoring.yaml" },
      { id: "icp-approve", by: "you", gate: true, label: "Approve ICP", detail: "Nothing is searched before you approve who to look for and how to score them.", check: ["Do the segments, sizes and countries match who you want?", "Are the scoring factors the things that make a good client for you?", "Do your best customers score high?"] },
    ],
  },
  {
    n: 1, id: "discover", short: "Find", title: "Find companies", stage: "discovered",
    blocks: [
      { id: "discover", by: "operator", agent: "operator", skills: ["discover"], label: "Searches the company index", detail: "Runs the ICP's search queries per segment and country, removes known companies, customers and do-not-contact entries, and saves new candidates.", tools: ["discover companies (Exa)"], writes: ["accounts/*/company.md"], example: "accounts/*/company.md" },
    ],
  },
  {
    n: 2, id: "light", short: "Quick scan", title: "Quick scan", stage: "light_scored",
    blocks: [
      { id: "light", by: "operator", agent: "operator", skills: ["enrich-light"], label: "Reads homepages, light score", detail: "In batches of 10: reads each homepage, writes a two-sentence cited snapshot, and scores only what a homepage can tell. Clear misfits are excluded.", uses: ["ase-context", "web"], tools: ["fetch pages"], writes: ["accounts/*/company.md", "accounts/*/scores/*.md"], example: "accounts/*/scores/*.md" },
    ],
  },
  {
    n: 3, id: "shortlist", short: "Shortlist", title: "Pick the best ones", stage: "shortlisted",
    blocks: [
      { id: "shortlist", by: "operator", agent: "operator", skills: ["shortlist"], label: "Proposes shortlist + cost", detail: "Ranks companies by fit and by what research could still reveal, and proposes the best ones with a cost estimate.", writes: ["lists/*/*/shortlist.md"], example: "lists/*/*/shortlist.md" },
      { id: "shortlist-approve", by: "you", gate: true, label: "Approve shortlist", detail: "Nothing expensive happens before you say yes.", check: ["Are these companies you'd actually want as clients?", "Remove anything you know is a no-go", "Is the cost estimate acceptable?"] },
    ],
  },
  {
    n: 4, id: "research", short: "Research", title: "Research and score", stage: "scored",
    blocks: [
      { id: "research-split", by: "operator", agent: "operator", skills: ["research"], label: "One researcher per company", detail: "Gives every shortlisted company its own Researcher, all working at the same time, so no context is shared or wasted between companies." },
      { id: "research-do", by: "account-researcher", agent: "account-researcher", skills: ["research"], label: "Site, news, people → brief", detail: "Reads the company's own pages, searches the news for dated events, finds people per buyer persona, and writes a brief where every statement quotes its source.", uses: ["ase-context", "web"], tools: ["fetch pages", "search news", "find people", "extract", "research agent", "web search"], writes: ["accounts/*/brief.md", "accounts/*/signals/*.md", "people/*.md"], example: "accounts/*/brief.md" },
      { id: "research-judge", by: "factor-judge", agent: "factor-judge", skills: ["score"], runIn: ["research", "score", "refresh", "sync"], label: "Scores each factor on evidence", detail: "Goes through the scoring model one factor at a time, gives each a level 0–3 with the exact quote behind it, and says 'unknown' instead of guessing. Never browses.", uses: ["evidence-pack"], writes: ["accounts/*/scores/*.md"], example: "accounts/*/scores/*.md" },
      { id: "research-record", by: "operator", agent: "operator", skills: ["score"], runIn: ["research", "score"], label: "Records scores, opens review", detail: "Applies the scores (the engine checks every quote against the saved page), commits the work on a branch and opens a pull request with what to double-check." },
      { id: "research-review", by: "you", gate: true, label: "Review scores", detail: "You decide which companies to approach.", check: ["Read the briefs of the top accounts", "Check the items flagged to double-check", "Merge the pull request to accept the work"] },
    ],
  },
  {
    n: 5, id: "ways-in", short: "Ways in", title: "Find a way in",
    blocks: [
      { id: "ways-in", by: "operator", agent: "operator", skills: ["ways-in"], label: "Warm paths and triggers", detail: "Matches the company's people against your team's LinkedIn connections, picks the freshest relevant events, and ranks the routes in, warmest first.", writes: ["accounts/*/brief.md"], example: "accounts/*/brief.md" },
    ],
  },
  {
    n: 6, id: "drafts", short: "Drafts", title: "Draft the first message", stage: "outreach_ready",
    blocks: [
      { id: "drafts", by: "operator", agent: "operator", skills: ["draft-outreach", "learn"], label: "Drafts in your voice", detail: "Writes each first message around one dated event, one insight and one clear ask, in your team's writing voice.", writes: ["accounts/*/drafts/*.md"], example: "accounts/*/drafts/*.md" },
      { id: "drafts-send", by: "you", gate: true, label: "Edit and send yourself", detail: "Nothing is ever sent automatically.", check: ["Is the trigger still fresh and correct?", "Would you send this to this person?", "Edit, then send from your own inbox"] },
    ],
  },
  {
    n: 7, id: "outcomes", short: "Outcomes", title: "Meetings and learning",
    blocks: [
      { id: "outcomes-log", by: "you", label: "Log replies, meetings, wins", detail: "You tell the engine what happened: a reply, a meeting, a win or a loss (with the reason).", skills: ["outcomes"], writes: ["outcomes/events.jsonl"] },
      { id: "outcomes-learn", by: "operator", agent: "operator", skills: ["call-prep", "outcomes", "learn"], label: "Call prep, win/loss review", detail: "Writes a one-page brief before each call, and compares outcomes with the scores to propose better weights and lessons.", writes: ["accounts/*/callprep/*.md", "icps/*/win-loss/*.md", "learnings/*.md"], example: "learnings/*.md" },
      { id: "outcomes-approve", by: "you", gate: true, label: "Approve improvements", detail: "Changes to the ICP and the scoring model only happen with your approval.", check: ["Do the proposed weight changes make sense?", "Are the lessons right?"] },
    ],
  },
  {
    n: "↻", id: "maintenance", short: "Maintenance", title: "Keeping it fresh", parallel: true,
    blocks: [
      // runIn keeps the old skill names so runs from before the merge still show up
      { id: "refresh", by: "operator", agent: "operator", skills: ["refresh"], runIn: ["refresh", "sync"], label: "News and fact check", detail: "Looks for new events at the companies you follow, re-checks facts that have expired (headcounts, titles, where people work), and re-scores what changed.", tools: ["search news", "fetch pages", "find people"], uses: ["web"], writes: ["accounts/*/signals/*.md", "sync/*.md"], example: "sync/*.md" },
      { id: "health", by: "operator", agent: "operator", skills: ["audit"], runIn: ["audit", "lint", "evals"], label: "Health check", detail: "A mechanical check of the knowledge base (invalid or unsourced files, broken stage rules, stale facts, duplicates) and the offline quality checks." },
      { id: "audit", by: "wiki-linter", agent: "wiki-linter", skills: ["audit"], runIn: ["audit", "lint"], label: "Deep audit", detail: "Reads briefs and their sources looking for contradictions and outdated narrative. On demand: it's the expensive part of an audit." },
    ],
  },
];

export const ACTORS = [
  { id: "you", name: "You", role: "Decide at the moments that matter" },
  { id: "operator", name: "Coordinator", role: "Runs every playbook and hands work to the specialists" },
  { id: "account-researcher", name: "Researcher", role: "Digs into one company: what they do, what's changing, who to talk to" },
  { id: "factor-judge", name: "Judge", role: "Scores factor by factor, strictly on the evidence" },
  { id: "wiki-linter", name: "Auditor", role: "Finds contradictions and stale information" },
  { id: "icp-analyst", name: "ICP analyst", role: "Studies your company and best customers" },
];
