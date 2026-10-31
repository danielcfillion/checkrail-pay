/**
 * "Ask about your setup": the assistant on "Your first weeks".
 *
 * A custom agent, the Checkrail guide, talks to the owner and hands work to Studio's own built-in agents (data,
 * widget, page, planning) through Studio's delegate tool. It is Studio's lead agent with Checkrail's instructions in
 * front: what the numbers mean, which custom widgets to use, and what it may not do. Every agent runs on Claude
 * through claudeAdapter(), which posts to this app's /api/studio-ai route (login required, rate limited); no key
 * reaches the browser.
 *
 * It explains and adds widgets. Studio's tools only read data and change the dashboard, so it cannot change a rule,
 * a setting or a supplier, and cannot pay anyone.
 */
import { createAiHarness, directLlmRunner, type AgAiHarnessSetup, type AgAiPromptStarter, type AgLlmAdapter } from "ag-studio";
import { claudeAdapter } from "./claudeAdapter";
import { FALSE_HOLDS, READINESS_GAUGE } from "./onboardingReport";

export const GUIDE_AGENT_ID = "checkrail-guide";

export const PROMPT_STARTERS: AgAiPromptStarter[] = [
  {
    label: "Why am I not ready for Autopilot yet?",
    prompt: "Why am I not ready for Autopilot yet? Use the readiness checks: say which are not met, where each stands against its target, and what would meet it. Keep it short.",
  },
  {
    label: "Which supplier causes most holds that turned out fine?",
    prompt: "Which supplier causes most holds that turned out fine? Use the flagged payments: count the ones I marked fine by supplier, and say what would stop them being held.",
  },
  {
    label: "Add a chart of money stopped by supplier",
    prompt: "Add a bar chart of money stopped by supplier (sum of the stopped amount of flagged payments, by supplier) below the widgets on this page.",
  },
];

export function guideInstructions(business: string, currency: string): string {
  return `## Checkrail
You are the Checkrail guide on "Your first weeks", the onboarding dashboard of ${business}. Checkrail checks every supplier payment, from a person or an AI agent, before money moves. The owner uploaded their bank history, Checkrail re-checked it, and the owner marked each flagged payment a right catch or fine. Readiness says when Checkrail may do more on its own: Review (a person approves everything), then Assist, then Autopilot.

## What you do
- Explain the numbers on this page in plain, short sentences, from the data. Name suppliers and amounts.
- Add, move or remove widgets when asked, through your sub-agents.
- For readiness, use the custom widget type ${READINESS_GAUGE}. For how often a hold turned out fine, use ${FALSE_HOLDS}. Neither needs a data mapping.

## What you never do
- You cannot change a rule, a setting, a rate card or a supplier, and you cannot approve, hold or pay anything. If asked, say so in one sentence and name the screen in the suggestion that makes the change.
- Never add held money to stopped money: held money waited for a person, stopped money would not have left.
- Money is in ${currency}. Do not convert currencies.
- Do not use em dashes. Write like a careful bookkeeper, not a marketer.

## Where the answers are
- Not ready yet: the readiness table's rows where met is false; each has a plain line saying what is missing. The suggestions table has the change that would fix it.
- Holds that turned out fine: weekly_false_holds by week (target 10%), or flagged payments with was_fine summed by supplier.
- Rule agreement: rule_hits.`;
}

/** The harness: the Checkrail guide first, then Studio's own agents it delegates to, all on Claude. */
export function buildOnboardingAi(opts: { business: string; currency: string; adapter?: AgLlmAdapter }): AgAiHarnessSetup {
  const adapter = opts.adapter ?? claudeAdapter();
  const preamble = guideInstructions(opts.business, opts.currency);
  return ({ api }) =>
    createAiHarness(api, ({ builtIn }) => ({
      primary: GUIDE_AGENT_ID,
      promptStarters: PROMPT_STARTERS,
      agents: [
        directLlmRunner({
          ...builtIn.lead,
          id: GUIDE_AGENT_ID,
          name: "Checkrail guide",
          description: "Talks to the owner about their first weeks with Checkrail and hands dashboard work to Studio's agents.",
          instructions: (ctx, params) => `${preamble}\n\n${builtIn.lead.instructions?.(ctx, params) ?? ""}`,
          adapter,
        }),
        ...(["data", "widget", "page", "planning"] as const).map((id) => directLlmRunner({ ...builtIn[id], adapter })),
      ],
    }));
}
