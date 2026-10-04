// ============================================================================
// W FLOW — spending controls on AI nodes
//
// Two optional settings every node that calls a model gets, in a "Spending"
// section before the error handling (the executor's budget guard,
// server/ai-budget.js, reads them while the node runs):
//
//   maxRunTokens — at most this many tokens for this node in one run; the last
//                  call gets only what is left as its output limit, so the
//                  reply is cut off at the cap instead of going past it.
//   reuseAnswers — an identical request (same model, settings and messages)
//                  within reuseHours answers from the saved reply: no tokens.
//                  Only for chat-style nodes; embeddings are never reused.
// ============================================================================

const CHAT_NODES = ["aiChat", "langchainChain", "aiAgent", "aiExtract", "aiClassify"];
const EMBEDDING_NODES = ["aiEmbeddings", "vectorStore", "vectorSearch"];

export const AI_CONTROL_KEYS = ["maxRunTokens", "reuseAnswers", "reuseHours"];

export function applyAiControlFields(nodes) {
  for (const type of [...CHAT_NODES, ...EMBEDDING_NODES]) {
    const def = nodes[type];
    if (!def || (def.fields || []).some((f) => f.key === "maxRunTokens")) continue;
    const fields = [
      {
        key: "maxRunTokens",
        label: "Token cap per run",
        type: "number",
        section: "Spending",
        optional: true,
        help: "At most this many tokens for this node in one run (all its items together). The last call's reply is cut off at the cap; after that the node stops with BF-5006. 0 = no cap.",
      },
    ];
    const defaults = { maxRunTokens: 0 };
    if (CHAT_NODES.includes(type)) {
      fields.push(
        {
          key: "reuseAnswers",
          label: "Reuse identical answers",
          type: "boolean",
          section: "Spending",
          optional: true,
          help: "When the exact same request (model, settings and messages) was answered recently, use that answer again instead of calling the model — no tokens spent. Leave off when every run must get a fresh answer.",
        },
        {
          key: "reuseHours",
          label: "Reuse answers for (hours)",
          type: "number",
          section: "Spending",
          optional: true,
          visibleWhen: { key: "reuseAnswers", value: true },
          help: "How long a saved answer may be reused.",
        }
      );
      Object.assign(defaults, { reuseAnswers: false, reuseHours: 24 });
    }
    def.fields = [...(def.fields || []), ...fields];
    def.defaults = { ...def.defaults, ...defaults };
  }
}
