// SaaSPress AI Studio backend (Cloudflare Worker + Workers AI)
// Check available models with: npx wrangler ai models list
// If this model is ever retired, replace the name below with another text model.
const MODEL = "@cf/meta/llama-3.1-8b-instruct";

const SYSTEM = {
  blog:
    "You are a writing assistant for SaaSPress, a website about SaaS software and AI tools. " +
    "Write clear, natural English for readers in the USA, UK, Canada and Australia. " +
    "Never invent statistics, quotes, personal experience, test results, prices or product features. " +
    "If a fact is needed that you cannot know, write the placeholder [add verified fact]. " +
    "Keep the answer under 350 words.",
  research:
    "You are a research planning assistant for SaaSPress, a website about SaaS software and AI tools. " +
    "You cannot browse the web and your knowledge may be out of date. " +
    "Never state prices, plan limits, user numbers or release dates as facts. Never invent URLs. " +
    "Help the user plan their research: what to find out, which kinds of official pages to check " +
    "(for example the tool's own pricing page, help center and terms), and common mistakes. " +
    "End with a short section titled 'Verify before you publish'. Keep the answer under 350 words."
};

const TASKS = {
  blog: {
    outline: "Create a clear blog post outline with an H1 and H2 headings for this topic:",
    headlines: "Write 10 headline ideas for this blog topic. Avoid hype and unproven claims:",
    intro: "Write a short, honest introduction (about 100 words) for a blog post on this topic:",
    improve: "Improve the clarity of this paragraph without changing its meaning or adding new facts:",
    meta: "Write 3 meta description options of about 150 to 160 characters for this blog topic:"
  },
  research: {
    plan: "Make a research plan for writing about this SaaS or AI tool:",
    compare: "List what to check when comparing these tools, and where to verify each point:",
    explain: "Explain this SaaS or tech term in simple language for a small business owner:"
  }
};

const hits = new Map(); // best-effort limit per visitor, per Worker instance
function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60000);
  list.push(now);
  hits.set(ip, list);
  return list.length > 5;
}
const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname !== "/api/ai") return env.ASSETS.fetch(req);
    if (req.method !== "POST") return json({ error: "method" }, 405);

    let body;
    try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
    const { mode, task } = body;
    const input = String(body.input || "").trim().slice(0, 1500);
    if (!TASKS[mode] || !TASKS[mode][task] || input.length < 3) return json({ error: "bad_request" }, 400);

    if (limited(req.headers.get("CF-Connecting-IP") || "unknown")) return json({ error: "rate" }, 429);

    try {
      const r = await env.AI.run(MODEL, {
        messages: [
          { role: "system", content: SYSTEM[mode] },
          { role: "user", content: TASKS[mode][task] + "\n\n" + input }
        ],
        max_tokens: 700
      });
      return json({ text: String(r.response || "").trim() });
    } catch (e) {
      return json({ error: "ai_unavailable" }, 503);
    }
  }
};
