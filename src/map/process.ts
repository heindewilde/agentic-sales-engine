/**
 * The engine explained in plain language: the journey from "who do we sell to" to "what did we learn", and who does
 * what. This is the story the agent map tells; live numbers (cost, runs, status) are attached per skill and agent.
 * Keep it in sync with the skills (skills/*) and the autopilot flow when either changes.
 */

export interface Role {
  agent: string; // agent name on the platform, without "ase-"
  title: string;
  oneLiner: string;
  does: string[];
  never: string;
  reads: string;
}

export const ROLES: Role[] = [
  {
    agent: "operator", title: "The Coordinator",
    oneLiner: "Runs every workflow from start to finish and hands work to the specialists.",
    does: ["Picks up a request (or a scheduled job) and follows the matching playbook", "Splits big jobs: one researcher per company, in parallel", "Checks the results, records them, and puts everything up for your review as a pull request"],
    never: "Never approves anything on your behalf, and never sends a message.",
    reads: "The playbooks (skills), the rules, and your workspace",
  },
  {
    agent: "account-researcher", title: "The Researcher",
    oneLiner: "Digs into one company: what they do, what's changing, and who to talk to.",
    does: ["Reads the company's own site: about, team, careers, news", "Searches the news for dated events (launches, new stores, hires)", "Finds the people that match your buyer personas", "Writes a brief where every statement quotes its source"],
    never: "Never scores the company: that's the Judge's job, so research and judgement stay separate.",
    reads: "Your ICP, the research playbook, and the company's pages and news",
  },
  {
    agent: "factor-judge", title: "The Judge",
    oneLiner: "Scores a company factor by factor, strictly on the evidence the Researcher found.",
    does: ["Goes through your scoring model one factor at a time", "Gives each factor a level (0–3) with the exact quote that supports it", "Says 'unknown' when there's no evidence, instead of guessing"],
    never: "Never browses the web: it only judges what's already gathered.",
    reads: "Your scoring model, the company's brief, and the evidence pack",
  },
  {
    agent: "icp-analyst", title: "The ICP Analyst",
    oneLiner: "Studies your own company and your best customers to define who you should sell to.",
    does: ["Analyses your website and sales material", "Researches your best (and worst) customers for common traits", "Turns that into an ideal customer profile and scoring factors"],
    never: "Never decides the ICP: it proposes, you approve.",
    reads: "Your website, your customers' public information",
  },
  {
    agent: "wiki-linter", title: "The Auditor",
    oneLiner: "Checks the knowledge base for contradictions and outdated information.",
    does: ["Spots two different headcounts for the same company", "Flags briefs that say something their sources don't", "Finds narrative that has gone stale"],
    never: "Never changes anything itself: it reports, the Coordinator fixes what's mechanical.",
    reads: "Briefs, company files and their sources",
  },
];

export interface Step {
  n: number;
  id: string;
  title: string;
  what: string; // one sentence
  input: string;
  output: string;
  who: string[]; // agents
  skills: string[]; // the playbooks behind this step
  you: { kind: "auto" | "approve" | "review" | "you"; text: string };
  how: string[]; // the hand-offs, in order
  when: string;
  short: string; // column title in the diagram
  stage?: string; // the account stage this step brings companies to (for the funnel)
  acts: { by: string; label: string; gate?: boolean }[]; // the swimlane boxes, in hand-off order ("you" = the user)
}

export const JOURNEY: Step[] = [
  {
    n: 0, short: "ICP", acts: [{ by: "icp-analyst", label: "Studies your site and best customers" }, { by: "operator", label: "Drafts ICP and scoring model" }, { by: "you", label: "Approve ICP", gate: true }],
    id: "icp", title: "Decide who you sell to", what: "Define your ideal customer and how to score a company against it.",
    input: "Your website, your best customers, your own judgement", output: "An approved ICP and a scoring model (what makes a company a good fit, a good moment, reachable)",
    who: ["operator", "icp-analyst"], skills: ["icp-build", "scoring-design"],
    you: { kind: "you", text: "You answer a few questions and approve the ICP and the scoring model." },
    how: ["The ICP Analyst studies your site and your best customers", "The Coordinator turns the common traits into a profile and asks you only about the gaps", "You approve; the scoring model is built from the profile and tested against your known customers"],
    when: "Once, and again when your market changes",
  },
  {
    n: 1, short: "Find", stage: "discovered", acts: [{ by: "operator", label: "Searches the company index" }],
    id: "discover", title: "Find companies", what: "Search for companies that match your ICP.",
    input: "Your ICP's search queries per segment and country", output: "A list of candidate companies (typically a few hundred)",
    who: ["operator"], skills: ["discover", "import"],
    you: { kind: "auto", text: "Nothing: it runs on its own. You can also import your own list." },
    how: ["The Coordinator runs your ICP's searches through the company index", "Known companies, customers and do-not-contact entries are filtered out", "New candidates are saved to your workspace"],
    when: "When you want new prospects",
  },
  {
    n: 2, short: "Quick scan", stage: "light_scored", acts: [{ by: "operator", label: "Reads homepages, light score" }],
    id: "light", title: "Quick scan", what: "A cheap first look at every candidate: what do they do, and do they roughly fit?",
    input: "The candidate list", output: "A short snapshot and a first (light) score per company",
    who: ["operator"], skills: ["enrich-light"],
    you: { kind: "auto", text: "Nothing: it runs on its own." },
    how: ["The Coordinator splits the list into batches of 10 and works on them in parallel", "Each company's homepage is read and summarised in two or three sourced sentences", "Only the factors you can judge from a homepage are scored; obvious misfits are excluded"],
    when: "Right after finding companies",
  },
  {
    n: 3, short: "Shortlist", stage: "shortlisted", acts: [{ by: "operator", label: "Proposes shortlist + cost" }, { by: "you", label: "Approve shortlist", gate: true }],
    id: "shortlist", title: "Pick the best ones", what: "Choose which companies deserve deep research.",
    input: "All light-scored companies", output: "A shortlist with a cost estimate",
    who: ["operator"], skills: ["shortlist"],
    you: { kind: "approve", text: "You approve the shortlist (or remove companies). Nothing expensive happens before you say yes." },
    how: ["The Coordinator ranks companies by fit and by what research could still reveal", "It proposes a shortlist with the expected cost", "You review it as a pull request and approve"],
    when: "After the quick scan",
  },
  {
    n: 4, short: "Research", stage: "scored", acts: [{ by: "operator", label: "One researcher per company" }, { by: "account-researcher", label: "Site, news, people → brief" }, { by: "factor-judge", label: "Scores each factor on evidence" }, { by: "operator", label: "Records scores, opens review" }, { by: "you", label: "Review scores", gate: true }],
    id: "research", title: "Research and score", what: "Deep research on each shortlisted company, then a careful score.",
    input: "The approved shortlist", output: "Per company: a sourced brief, dated triggers, the right people, and a full score (fit, timing, access)",
    who: ["operator", "account-researcher", "factor-judge"], skills: ["research", "score"],
    you: { kind: "review", text: "You review the scores and the briefs, correct what's off, and decide who to approach." },
    how: ["The Coordinator gives every company its own Researcher, all working at the same time", "Each Researcher reads the company's site, news and people, and writes a brief with quotes", "For every company a Judge scores each factor strictly on that evidence", "The Coordinator records the scores and puts everything up for your review, with a list of things to double-check"],
    when: "After you approve the shortlist",
  },
  {
    n: 5, short: "Ways in", acts: [{ by: "operator", label: "Warm paths and triggers" }],
    id: "ways-in", title: "Find a way in", what: "For the companies you want, find the best route to the right person.",
    input: "Researched, approved companies", output: "Ranked ways in: warm introductions, recent events to mention, shared context",
    who: ["operator"], skills: ["ways-in"],
    you: { kind: "auto", text: "Nothing: it runs on its own for the companies you picked." },
    how: ["The Coordinator matches the company's people against your team's LinkedIn connections", "It picks the freshest, most relevant events as conversation openers", "It ranks the routes, warmest first"],
    when: "After you pick companies to approach",
  },
  {
    n: 6, short: "Drafts", stage: "outreach_ready", acts: [{ by: "operator", label: "Drafts in your voice" }, { by: "you", label: "Edit and send yourself", gate: true }],
    id: "drafts", title: "Draft the first message", what: "A personal first message per company, in your team's voice.",
    input: "The way in and the brief", output: "Draft emails, LinkedIn notes or intro requests",
    who: ["operator"], skills: ["draft-outreach", "voice-profile"],
    you: { kind: "review", text: "You read, edit and send the drafts yourself. Nothing is ever sent automatically." },
    how: ["The Coordinator writes each draft around one dated event, one insight and one clear ask", "It follows your team's writing voice (learned from emails you liked and from your edits)", "Drafts wait in your workspace for you"],
    when: "After the ways in",
  },
  {
    n: 7, short: "Outcomes", stage: "engaged", acts: [{ by: "you", label: "Log replies, meetings, wins" }, { by: "operator", label: "Call prep, win/loss review" }, { by: "you", label: "Approve improvements", gate: true }],
    id: "outcomes", title: "Meetings and learning", what: "Prepare calls, log what happened, and let the engine learn from it.",
    input: "Replies, meetings, wins and losses", output: "Call briefs, an outcome history, and proposed improvements to the ICP and scoring",
    who: ["operator"], skills: ["call-prep", "log-outcome", "review-outcomes", "win-loss", "learn"],
    you: { kind: "you", text: "You log outcomes (a reply, a meeting, a win or a loss) and approve proposed changes." },
    how: ["Before a meeting the Coordinator writes a one-page call brief", "You log what happened; a weekly review asks about anything still open", "Win/loss compares outcomes with the scores and proposes better weights, which you approve"],
    when: "Ongoing, once outreach is out",
  },
];

export const MAINTENANCE = {
  title: "Keeping it fresh",
  what: "Small jobs that run on a schedule, so the knowledge doesn't go stale.",
  jobs: [
    { skill: "sync", title: "News check", text: "Looks for new events at the companies you follow and updates their scores." },
    { skill: "refresh", title: "Fact refresh", text: "Re-checks facts that have expired, like headcounts and job titles." },
    { skill: "lint", title: "Health check", text: "Checks the knowledge base for broken or unsourced files (a cheap, mechanical check)." },
  ],
  other: ["status", "evals", "dnc", "setup", "forget-person", "autopilot"],
};
