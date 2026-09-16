// src/lib/campaignTypes.ts
//
// Single source of truth for Arc Trials campaign types. Every surface that
// renders a type label/badge (create form, trials list, campaign page, admin,
// tester profile, leaderboard) reads from here — so adding a type is a
// one-line change, and no page can drift out of sync showing a raw id.
//
// `contract`:
//   required → a deployed contract address is mandatory (on-chain verified)
//   hidden   → product/content only, no contract field shown
//   optional → founder may attach a contract, but it isn't required

export interface CampaignType {
  id: string
  abbr: string
  label: string
  color: string
  tag: string
  desc: string
  contract: "required" | "hidden" | "optional"
}

export const CAMPAIGN_TYPES: CampaignType[] = [
  // ── Custom — build any campaign from scratch. Leads the picker; the flexibility
  //    signal for "run any campaign here". Still proof-backed: the founder defines
  //    the tasks, and the same title/proof/question rules apply as every type.
  { id: "custom",        abbr: "＋", label: "Custom",             color: "#a855f7", tag: "Build your own", desc: "Start from a blank slate and define your own tasks, proofs, and questions — for any campaign a preset doesn't cover", contract: "optional" },
  // ── Testing / product (the original core) ──────────────────────────────────
  { id: "beta_test",     abbr: "BT", label: "Beta Test",          color: "#1a56ff", tag: "Most popular", desc: "Walk real users through your core contract flow end-to-end on Arc Testnet",              contract: "required" },
  { id: "payment_flow",  abbr: "PF", label: "Payment Flow Test",  color: "#00d990", tag: "Arc native",   desc: "Verify USDC transfers, settlement logic, and multi-step payment sequences",              contract: "required" },
  { id: "stress_test",   abbr: "ST", label: "Stress Test",        color: "#e08810", tag: "Break it",     desc: "Push it to the limits — rapid transactions, concurrency, boundary values, and edge-case inputs that break contract logic", contract: "required" },
  { id: "ux_review",     abbr: "UX", label: "UX Review",          color: "#00b87a", tag: "Experience",   desc: "First impressions, friction points, and whether a brand-new user can figure it out with no docs", contract: "hidden"   },
  { id: "integration",   abbr: "IT", label: "Integration Test",   color: "#6366f1", tag: "Ecosystem",    desc: "Verify your protocol interoperates correctly with other Arc contracts",                  contract: "required" },
  { id: "builder_audit", abbr: "BA", label: "Builder Audit",      color: "#ec4899", tag: "Developer",    desc: "Invite builders to review your contract code, architecture, and security",                contract: "required" },
  // ── Growth / real-usage (proof-backed, reputation-scored — never click-farm) ─
  { id: "adoption",      abbr: "NU", label: "New Users",          color: "#14b8a6", tag: "Growth",       desc: "Get real first-time users to try your product and report back — every step proof-backed", contract: "optional" },
]

// Legacy / folded type values that resolve to a surviving canonical type. Keeps
// old campaigns and any stray input rendering correctly after consolidation:
//   edge_case  → folded into stress_test (adversarial / break-it testing)
//   onboarding → folded into ux_review   (first-time experience is a UX concern)
//   journey    → folded into beta_test   (a multi-step flow IS the core flow)
export const TYPE_ALIASES: Record<string, string> = {
  feedback: "ux_review",
  edge_case: "stress_test",
  onboarding: "ux_review",
  journey: "beta_test",
}

export const TYPE_META: Record<string, CampaignType> = Object.fromEntries(
  CAMPAIGN_TYPES.map(t => [t.id, t]),
)

export const CONTRACT_REQUIRED = new Set(CAMPAIGN_TYPES.filter(t => t.contract === "required").map(t => t.id))
export const CONTRACT_HIDDEN   = new Set(CAMPAIGN_TYPES.filter(t => t.contract === "hidden").map(t => t.id))

export function getTypeMeta(type: string): CampaignType {
  return TYPE_META[type] || TYPE_META[TYPE_ALIASES[type]] || TYPE_META.beta_test
}

export const CAMPAIGN_TYPE_LABELS: Record<string, string> = Object.fromEntries(
  CAMPAIGN_TYPES.map(t => [t.id, t.label]),
)

// ── Templates ────────────────────────────────────────────────────────────────
// Starter tasks/questions per type. Founders MUST edit them — testers see these
// instructions verbatim. Both the create form and the API reject submissions
// that still match a template unchanged (see matchesDefaultTemplate).

export type ProofType = "none" | "x_link" | "tx_hash" | "url" | "screenshot"
export interface TemplateTask { id: string; title: string; description: string; contract_address?: string; proof_type?: ProofType }
export interface TemplateQuestion { id: string; label: string; placeholder: string; min_words: number; required: boolean }

export const CAMPAIGN_TEMPLATES: Record<string, { tasks: TemplateTask[]; questions: TemplateQuestion[] }> = {
  // Custom starts blank — the founder fills every field. Empty title/label are
  // caught by the create form's validation, so a blank custom can't be submitted.
  custom: {
    tasks: [
      { id: "t1", title: "", description: "" },
    ],
    questions: [
      { id: "q1", label: "", placeholder: "What should testers tell you after completing this campaign?", min_words: 20, required: true },
    ],
  },
  beta_test: {
    tasks: [
      { id: "t1", title: "Connect your wallet to the app", description: "Use MetaMask or Rabby on Arc Testnet" },
      { id: "t2", title: "Complete the core action", description: "Execute the main function as a first-time user would" },
      { id: "t3", title: "Verify the outcome", description: "Confirm the result is visible and matches what was promised" },
    ],
    questions: [
      { id: "q1", label: "What worked exactly as expected?", placeholder: "Be specific — which steps, screens, or outcomes felt smooth?", min_words: 30, required: true },
      { id: "q2", label: "What confused or slowed you down?", placeholder: "Any step where you hesitated, got an error, or weren't sure what to do.", min_words: 30, required: true },
      { id: "q3", label: "If you were the founder, what would you fix first?", placeholder: "One concrete change that would most improve the experience.", min_words: 20, required: true },
    ],
  },
  stress_test: {
    tasks: [
      { id: "t1", title: "Execute 5 transactions in quick succession", description: "Send 5 separate transactions within 2 minutes — Arc finalizes in under 1 second so pace them fast" },
      { id: "t2", title: "Try zero, minimum, and maximum input values", description: "Attempt the core action at both extremes of the valid input range, plus a zero-value edge" },
      { id: "t3", title: "Submit a transaction while a prior one is still confirming", description: "Test concurrent state — does the contract handle overlapping nonces correctly?" },
      { id: "t4", title: "Interrupt or reorder a multi-step flow", description: "Leave mid-way and return, or attempt a later step first — does state stay consistent?" },
    ],
    questions: [
      { id: "q1", label: "What failed, reverted, or gave unexpected output — and at what input?", placeholder: "Which attempt, the exact value, the error, and what you expected instead.", min_words: 30, required: true },
      { id: "q2", label: "How did the contract hold up under rapid, concurrent, or out-of-order input?", placeholder: "Nonce issues, race conditions, stuck state, interrupted flows — describe exactly what you observed.", min_words: 30, required: true },
    ],
  },
  ux_review: {
    tasks: [
      { id: "t1", title: "Come in cold, as a first-time user", description: "Homepage only — no docs, no prior knowledge. See if you can figure out the first action yourself." },
      { id: "t2", title: "Explore the app freely for 10–15 minutes", description: "Use it like a real user — don't follow a script" },
    ],
    questions: [
      { id: "q1", label: "As a newcomer, could you figure out what to do — and what stood out in the first 60 seconds?", placeholder: "What was obvious, what was unclear, and where you had to guess.", min_words: 30, required: true },
      { id: "q2", label: "Where did you feel friction or confusion?", placeholder: "Any moment you weren't sure what to do, or something behaved unexpectedly.", min_words: 25, required: true },
      { id: "q3", label: "Would you use this with real funds on mainnet?", placeholder: "Be honest. What would need to change? What already earns your trust?", min_words: 20, required: true },
    ],
  },
  integration: {
    tasks: [
      { id: "t1", title: "Acquire USDC or tokens from another Arc protocol", description: "Use a listed Arc protocol (lending, AMM, etc.) to get the assets needed for this test" },
      { id: "t2", title: "Execute the cross-contract interaction", description: "Use those assets to interact with this campaign's target contract" },
      { id: "t3", title: "Verify final state across both protocols", description: "Confirm balances, allowances, and events are consistent on both sides" },
    ],
    questions: [
      { id: "q1", label: "Did the cross-protocol flow complete correctly end-to-end?", placeholder: "Each step, any failures, and whether the final on-chain state was correct.", min_words: 35, required: true },
      { id: "q2", label: "Where did the integration feel fragile or break down?", placeholder: "Approval issues, unexpected reverts, USDC allowance problems, confusing handoffs?", min_words: 25, required: true },
    ],
  },
  payment_flow: {
    tasks: [
      { id: "t1", title: "Initiate a USDC transfer or payment through the contract", description: "Execute the primary payment function — send, deposit, or settle as the protocol intends" },
      { id: "t2", title: "Verify the recipient balance and on-chain state", description: "Confirm the correct amount landed, events were emitted, and state updated as expected" },
      { id: "t3", title: "Test a reversal, cancellation, or dispute path (if applicable)", description: "Try to reverse, cancel, or dispute the payment — does the contract handle it correctly?" },
    ],
    questions: [
      { id: "q1", label: "Did the USDC flow complete correctly and settle to the right address?", placeholder: "Exact amounts, wallet addresses involved, and whether the final balance matched.", min_words: 30, required: true },
      { id: "q2", label: "Were there any stuck states, reverts, or incorrect balances?", placeholder: "Any step where funds appeared lost, locked, or not where they should be.", min_words: 30, required: true },
      { id: "q3", label: "How did the contract handle edge amounts (zero, max, odd decimals)?", placeholder: "Did very small or very large USDC amounts behave correctly? What broke?", min_words: 20, required: true },
    ],
  },
  builder_audit: {
    tasks: [
      { id: "t1", title: "Read the source code or architecture docs", description: "Review the provided contract source, README, or architecture overview" },
      { id: "t2", title: "Run the test suite locally", description: "Clone the repo, run tests, note coverage gaps or failing cases" },
      { id: "t3", title: "Execute the most complex function on testnet", description: "Verify behavior matches spec under real conditions" },
    ],
    questions: [
      { id: "q1", label: "List any logic errors, attack vectors, or inefficiencies you found", placeholder: "Function name, severity, suggested fix. Be as specific as possible.", min_words: 50, required: true },
      { id: "q2", label: "What aspects of the architecture are well designed?", placeholder: "What would you reuse or highlight in a peer review?", min_words: 25, required: true },
    ],
  },
  adoption: {
    tasks: [
      { id: "t1", title: "Try the product's core action for the first time", description: "Use it as a genuine new user would — no shortcuts", proof_type: "tx_hash" },
      { id: "t2", title: "Share your honest first impression publicly", description: "A short post on X about your experience — good or bad", proof_type: "x_link" },
    ],
    questions: [
      { id: "q1", label: "As a first-time user, what made you want to keep using it (or not)?", placeholder: "Be specific — the moment it clicked, or the moment you hesitated.", min_words: 30, required: true },
      { id: "q2", label: "Would you use this with real funds on mainnet? Why?", placeholder: "What would need to change to earn your trust?", min_words: 20, required: true },
    ],
  },
}

/**
 * True when the submitted tasks still match a type's starter template verbatim
 * (same count + same titles). Used by BOTH the create form and the API guard,
 * so "default garbage" is blocked everywhere — every type, not just beta.
 */
export function matchesDefaultTemplate(type: string, tasks: { title?: string }[]): boolean {
  const tpl = CAMPAIGN_TEMPLATES[type]?.tasks
  if (!tpl || !Array.isArray(tasks) || tasks.length !== tpl.length) return false
  const norm = (s: string) => s.trim().toLowerCase()
  return tpl.every((t, i) => norm(tasks[i]?.title || "") === norm(t.title))
}
