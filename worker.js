// SaaSPress AI Studio + authenticated article publishing (Cloudflare Worker + Workers AI)
const MODEL = "@cf/meta/llama-3.1-8b-instruct";
const OWNER = "seobacklinksbyab-cell";
const REPO = "saaspress";
const BRANCH = "main";
const SITE = "https://saaspress.co.uk";
const COOKIE = "__Host-saaspress-admin";
const SESSION_SECONDS = 60 * 60 * 12;
const SYSTEM = {
  blog: "You are a writing assistant for SaaSPress, a website about SaaS software and AI tools. Write clear, natural English for readers in the USA, UK, Canada and Australia. Never invent statistics, quotes, personal experience, test results, prices or product features. If a fact is needed that you cannot know, write the placeholder [add verified fact]. Keep the answer under 350 words.",
  research: "You are a research planning assistant for SaaSPress, a website about SaaS software and AI tools. You cannot browse the web and your knowledge may be out of date. Never state prices, plan limits, user numbers or release dates as facts. Never invent URLs. Help the user plan their research: what to find out, which kinds of official pages to check (for example the tool's own pricing page, help center and terms), and common mistakes. End with a short section titled 'Verify before you publish'. Keep the answer under 350 words."
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

const hits = new Map();
const loginHits = new Map();
function limited(map, ip, max, windowMs) {
  const now = Date.now();
  const list = (map.get(ip) || []).filter((t) => now - t < windowMs);
  list.push(now);
  map.set(ip, list);
  return list.length > max;
}
const json = (o, s = 200, extra = {}) => new Response(JSON.stringify(o), { status: s, headers: Object.assign({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, extra) });
const encoder = new TextEncoder();
function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function escapeXml(s) { return escapeHtml(s); }
function dateLabel(iso) { return new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }); }
function cleanArticleHtml(html, nofollow) {
  let out = String(html || "").slice(0, 500000).replace(/<!--[\s\S]*?-->/g, "");
  out = out.replace(/<(script|style|iframe|object|embed|form|svg|math|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  const allowed = new Set(["p", "br", "strong", "b", "em", "i", "u", "h2", "h3", "ul", "ol", "li", "blockquote", "a", "img", "hr"]);
  out = out.replace(/<([a-z][a-z0-9]*)\b([^>]*)>/gi, (whole, rawTag, attrs) => {
    const tag = rawTag.toLowerCase();
    if (!allowed.has(tag)) return "";
    if (tag === "a") {
      const match = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
      const href = match ? String(match[1] || match[2] || match[3] || "").trim() : "";
      if (!/^https?:\/\//i.test(href) && !/^mailto:/i.test(href)) return "<a>";
      const titleMatch = /\btitle\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
      const relMatch = /\brel\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
      const rels = new Set(String(relMatch && (relMatch[1] || relMatch[2]) || "").toLowerCase().split(/\s+/).filter((x) => ["sponsored", "ugc", "nofollow"].includes(x)));
      if (nofollow) rels.add("nofollow");
      return "<a href=\"" + escapeHtml(href) + "\" target=\"_blank\"" + (rels.size ? " rel=\"" + Array.from(rels).join(" ") + "\"" : "") + (titleMatch ? " title=\"" + escapeHtml(titleMatch[1] || titleMatch[2] || "") + "\"" : "") + ">";
    }
    if (tag === "img") {
      const srcMatch = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
      const src = String(srcMatch && (srcMatch[1] || srcMatch[2] || srcMatch[3]) || "").trim();
      if (!/^https?:\/\//i.test(src)) return "";
      const altMatch = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
      return "<img src=\"" + escapeHtml(src) + "\" alt=\"" + escapeHtml(altMatch && (altMatch[1] || altMatch[2]) || "") + "\" loading=\"lazy\">";
    }
    return tag === "br" || tag === "hr" ? "<" + tag + ">" : "<" + tag + ">";
  });
  out = out.replace(/<\/([a-z][a-z0-9]*)\s*>/gi, (whole, rawTag) => {
    const tag = rawTag.toLowerCase();
    return allowed.has(tag) && tag !== "br" && tag !== "hr" && tag !== "img" ? "</" + tag + ">" : "";
  });
  return out;
}
async function sessionSignature(exp, secret) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(String(exp))));
  let binary = "";
  for (let i = 0; i < sig.length; i++) binary += String.fromCharCode(sig[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function cookieValue(req) {
  const raw = req.headers.get("Cookie") || "";
  const part = raw.split(";").map((x) => x.trim()).find((x) => x.startsWith(COOKIE + "="));
  return part ? decodeURIComponent(part.slice(COOKIE.length + 1)) : "";
}
async function isAdmin(req, env) {
  if (!env.ADMIN_SESSION_SECRET) return false;
  const value = cookieValue(req).split(".");
  if (value.length !== 2) return false;
  const exp = Number(value[0]);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  return value[1] === await sessionSignature(exp, env.ADMIN_SESSION_SECRET);
}
function sameOrigin(req) {
  const origin = req.headers.get("Origin");
  return !origin || origin === SITE;
}
function cookieHeader(value, maxAge) {
  return COOKIE + "=" + encodeURIComponent(value) + "; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=" + maxAge;
}
async function gh(env, path, method, data) {
  const response = await fetch("https://api.github.com/repos/" + OWNER + "/" + REPO + path, {
    method: method || "GET",
    headers: { "Accept": "application/vnd.github+json", "Authorization": "Bearer " + env.GITHUB_TOKEN, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "SaaSPress-Article-Desk", "Content-Type": "application/json" },
    body: data ? JSON.stringify(data) : undefined
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error("github_" + response.status + "_" + String(body.message || "request_failed").slice(0, 100));
  return body;
}
async function getTextFile(env, path) {
  const item = await gh(env, "/contents/" + encodeURIComponent(path) + "?ref=" + encodeURIComponent(BRANCH));
  if (!item.content) throw new Error("github_file_missing_" + path);
  const binary = atob(item.content.replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
function cardHtml(a) {
  const image = a.imagePath ? '<img src="' + escapeHtml(a.imagePath) + '" alt="' + escapeHtml(a.imageAlt || a.title) + '" loading="lazy">' : '<span>' + escapeHtml(a.category) + '</span>';
  return '<article class="latest-card"><a class="latest-thumb" href="' + escapeHtml(a.slug) + '">' + image + '</a><div class="latest-info"><div class="latest-meta"><span>' + escapeHtml(a.dateLabel) + '</span><span>Reading Time: ' + a.readingMinutes + ' minutes</span></div><h2><a href="' + escapeHtml(a.slug) + '">' + escapeHtml(a.title) + '</a></h2><p class="latest-by">By ' + escapeHtml(a.byline) + ' · ' + escapeHtml(a.category) + '</p><p>' + escapeHtml(a.excerpt) + '</p></div></article>';
}
function articleHtml(a) {
  const canonical = SITE + "/" + a.slug;
  const robots = a.indexing === "noindex" ? "noindex,follow" : "index,follow";
  const articleJson = JSON.stringify({ "@context": "https://schema.org", "@type": "Article", headline: a.title, datePublished: a.date, dateModified: a.date, author: { "@type": "Person", name: a.byline }, publisher: { "@type": "Organization", name: "SaaSPress" }, mainEntityOfPage: canonical }).replace(/</g, "\\u003c");
  const imageMeta = a.imagePath ? '<meta property="og:image" content="' + escapeHtml(SITE + "/" + a.imagePath) + '">' : "";
  return '<!DOCTYPE html>\n<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">\n<title>' + escapeHtml(a.seoTitle) + '</title><meta name="description" content="' + escapeHtml(a.description) + '"><meta name="robots" content="' + robots + '"><link rel="canonical" href="' + canonical + '"><meta property="og:title" content="' + escapeHtml(a.seoTitle) + '"><meta property="og:description" content="' + escapeHtml(a.description) + '"><meta property="og:type" content="article">' + imageMeta + '\n<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Poppins:wght@600;700&display=swap" rel="stylesheet"><link rel="icon" href="favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="style.css"><script type="application/ld+json">' + articleJson + '</script><style>.post-head{padding:24px 0 28px;max-width:820px}.post-head h1{font-size:clamp(2rem,4.2vw,3rem);margin:10px 0 14px}.post-meta{display:flex;gap:16px;flex-wrap:wrap;font-size:.92rem;color:var(--muted)}.post-body{max-width:820px;font-size:1.08rem;line-height:1.8;padding-bottom:70px}.post-body h2{font-size:1.65rem;margin:1.8em 0 .5em}.post-body img{max-width:100%;height:auto;border-radius:10px}.post-body blockquote{margin:1.4em 0;padding:4px 0 4px 20px;border-left:4px solid var(--blue);color:var(--navy)}.post-body a{overflow-wrap:anywhere}</style></head><body><header class="site-header"><div class="wrap nav"><a href="index.html" class="logo">SaaS<span>Press</span></a><button class="toggle" id="toggle" aria-label="Open menu" aria-expanded="false">&#9776;</button><ul class="menu" id="menu"><li><a href="index.html">Home</a></li><li><a href="blog.html" aria-current="page">Blog</a></li><li><a href="about.html">About</a></li><li><a href="contact.html">Contact</a></li><li><a href="write-for-us.html" class="btn btn-orange">Write for Us</a></li></ul></div></header><main class="wrap"><nav class="crumbs" aria-label="Breadcrumb"><a href="index.html">Home</a> / <a href="blog.html">Blog</a> / ' + escapeHtml(a.category) + '</nav><header class="post-head"><div class="tag">' + escapeHtml(a.category) + '</div><h1>' + escapeHtml(a.title) + '</h1><div class="post-meta"><span>By ' + escapeHtml(a.byline) + '</span><time datetime="' + a.date + '">' + a.dateLabel + '</time><span>Reading Time: ' + a.readingMinutes + ' minutes</span></div></header><article class="post-body">' + a.content + '<aside class="author"><div class="avatar">' + escapeHtml(a.byline.slice(0, 1).toUpperCase()) + '</div><div><h3>' + escapeHtml(a.byline) + '</h3><p>Published on SaaSPress.</p></div></aside></article></main><footer class="site-footer"><div class="wrap"><div class="copy">&copy; <span id="yr">2026</span> SaaSPress. All rights reserved.</div></div></footer><script>document.getElementById("yr").textContent=new Date().getFullYear();var t=document.getElementById("toggle"),m=document.getElementById("menu");t.addEventListener("click",function(){var o=m.classList.toggle("open");t.setAttribute("aria-expanded",o)});</script></body></html>';
}
function utf8Base64(value) {
  const bytes = encoder.encode(value);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(binary);
}
async function publishArticle(req, env) {
  if (!env.GITHUB_TOKEN) throw new Error("github_token_not_configured");
  let data;
  try { data = await req.json(); } catch { throw new Error("invalid_json"); }
  const title = String(data.title || "").trim().slice(0, 180);
  const slug = String(data.slug || "").toLowerCase();
  const author = String(data.author || "Haseeb").trim().slice(0, 100) || "Haseeb";
  const byline = data.bylineType === "admin" ? "Admin" : author;
  const category = String(data.category || "SaaS Tools").trim().slice(0, 60);
  const seoTitle = String(data.seoTitle || title).trim().slice(0, 180);
  const description = String(data.description || "").trim().slice(0, 170);
  const indexing = data.indexing === "noindex" ? "noindex" : "index";
  const nofollow = data.linkPolicy === "nofollow";
  const content = cleanArticleHtml(data.content, nofollow);
  if (!title || !description || !content.replace(/<[^>]+>/g, "").trim()) throw new Error("title_description_content_required");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 90) throw new Error("invalid_slug");
  if (data.coverData && String(data.coverData).length > 1500000) throw new Error("image_too_large");

  const pagePath = slug + ".html";
  const existingResponse = await fetch("https://api.github.com/repos/" + OWNER + "/" + REPO + "/contents/" + encodeURIComponent(pagePath) + "?ref=" + encodeURIComponent(BRANCH), { headers: { "Accept": "application/vnd.github+json", "Authorization": "Bearer " + env.GITHUB_TOKEN, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "SaaSPress-Article-Desk" } });
  if (existingResponse.status === 200) throw new Error("slug_already_exists");
  if (existingResponse.status !== 404) throw new Error("github_check_failed");

  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const dateLabel = dateLabelFromIso(date);
  const words = content.replace(/<[^>]*>/g, " ").replace(/&[a-z0-9#]+;/gi, " ").trim().split(/\s+/).filter(Boolean).length;
  const readingMinutes = Math.max(1, Math.ceil(words / 200));
  let imagePath = "";
  let imageAlt = String(data.coverAlt || "").trim().slice(0, 150);
  const tree = [];
  if (data.coverData) {
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(data.coverData));
    if (!match) throw new Error("unsupported_image_type");
    const extension = match[1] === "jpeg" ? "jpg" : match[1];
    const blob = await gh(env, "/git/blobs", "POST", { content: match[2], encoding: "base64" });
    imagePath = "images/" + slug + "." + extension;
    imageAlt = imageAlt || title;
    tree.push({ path: imagePath, mode: "100644", type: "blob", sha: blob.sha });
  }
  const a = { title, slug, author, byline, category, seoTitle, description, indexing, date, dateLabel, readingMinutes, content, imagePath, imageAlt, excerpt: String(data.excerpt || "").trim().slice(0, 220) };
  if (!a.excerpt) a.excerpt = content.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 190);
  const blog = await getTextFile(env, "blog.html");
  const startMarker = "<!-- SAASPRESS_ARTICLES_START -->";
  const endMarker = "<!-- SAASPRESS_ARTICLES_END -->";
  const start = blog.indexOf(startMarker);
  const end = blog.indexOf(endMarker);
  if (start < 0 || end < start) throw new Error("blog_markers_missing");
  const updatedBlog = blog.slice(0, start + startMarker.length) + "\n      " + cardHtml(a) + blog.slice(start + startMarker.length);
  let sitemap = await getTextFile(env, "sitemap.xml");
  const canonical = SITE + "/" + slug;
  if (sitemap.indexOf("<loc>" + canonical + "</loc>") >= 0) throw new Error("sitemap_url_exists");
  const sitemapEntry = "  <url><loc>" + escapeXml(canonical) + "</loc><lastmod>" + date + "</lastmod></url>\n";
  if (!sitemap.includes("</urlset>")) throw new Error("invalid_sitemap");
  sitemap = sitemap.replace("</urlset>", sitemapEntry + "</urlset>");

  const ref = await gh(env, "/git/ref/heads/" + BRANCH);
  const parentSha = ref.object.sha;
  const parentCommit = await gh(env, "/git/commits/" + parentSha);
  tree.push({ path: pagePath, mode: "100644", type: "blob", content: articleHtml(a) });
  tree.push({ path: "blog.html", mode: "100644", type: "blob", content: updatedBlog });
  tree.push({ path: "sitemap.xml", mode: "100644", type: "blob", content: sitemap });
  const newTree = await gh(env, "/git/trees", "POST", { base_tree: parentCommit.tree.sha, tree });
  const newCommit = await gh(env, "/git/commits", "POST", { message: "Publish article: " + title.slice(0, 65), tree: newTree.sha, parents: [parentSha] });
  await gh(env, "/git/refs/heads/" + BRANCH, "PATCH", { sha: newCommit.sha, force: false });
  return { ok: true, url: canonical, title, date, dateLabel, readingMinutes, message: "Article committed to GitHub. It will appear after the connected site deployment finishes." };
}
function dateLabelFromIso(iso) { return new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }); }
async function adminRoute(req, env, url) {
  if (!sameOrigin(req)) return json({ error: "origin_not_allowed" }, 403);
  const ip = req.headers.get("CF-Connecting-IP") || "unknown";
  if (url.pathname === "/api/admin/login") {
    if (req.method !== "POST") return json({ error: "method" }, 405);
    if (limited(loginHits, ip, 10, 15 * 60 * 1000)) return json({ error: "too_many_attempts" }, 429);
    if (!env.ADMIN_PASSWORD || !env.ADMIN_SESSION_SECRET) return json({ error: "admin_secrets_not_configured" }, 503);
    let body;
    try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
    const supplied = encoder.encode(String(body.password || ""));
    const expected = encoder.encode(env.ADMIN_PASSWORD);
    const digest1 = new Uint8Array(await crypto.subtle.digest("SHA-256", supplied));
    const digest2 = new Uint8Array(await crypto.subtle.digest("SHA-256", expected));
    let diff = 0;
    for (let i = 0; i < digest1.length; i++) diff |= digest1[i] ^ digest2[i];
    if (diff !== 0 || supplied.length < 1) return json({ error: "incorrect_password" }, 401);
    const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
    const token = String(exp) + "." + await sessionSignature(exp, env.ADMIN_SESSION_SECRET);
    return json({ ok: true }, 200, { "set-cookie": cookieHeader(token, SESSION_SECONDS) });
  }
  if (url.pathname === "/api/admin/logout") {
    if (req.method !== "POST") return json({ error: "method" }, 405);
    return json({ ok: true }, 200, { "set-cookie": cookieHeader("", 0) });
  }
  if (!await isAdmin(req, env)) return json({ error: "login_required" }, 401);
  if (url.pathname === "/api/admin/session") return req.method === "GET" ? json({ ok: true }) : json({ error: "method" }, 405);
  if (url.pathname === "/api/admin/publish") {
    if (req.method !== "POST") return json({ error: "method" }, 405);
    try { return json(await publishArticle(req, env)); }
    catch (e) { return json({ error: String(e.message || "publish_failed") }, 400); }
  }
  return json({ error: "not_found" }, 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/admin" || url.pathname === "/admin/") {
      return env.ASSETS.fetch(new Request(new URL("/admin.html", url), req));
    }
    if (url.pathname.startsWith("/api/admin/")) return adminRoute(req, env, url);
    if (url.pathname !== "/api/ai") return env.ASSETS.fetch(req);
    if (req.method !== "POST") return json({ error: "method" }, 405);
    let body;
    try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
    const mode = body.mode, task = body.task;
    const input = String(body.input || "").trim().slice(0, 1500);
    if (!TASKS[mode] || !TASKS[mode][task] || input.length < 3) return json({ error: "bad_request" }, 400);
    if (limited(hits, req.headers.get("CF-Connecting-IP") || "unknown", 5, 60000)) return json({ error: "rate" }, 429);
    try {
      const r = await env.AI.run(MODEL, { messages: [{ role: "system", content: SYSTEM[mode] }, { role: "user", content: TASKS[mode][task] + "\n\n" + input }], max_tokens: 700 });
      return json({ text: String(r.response || "").trim() });
    } catch (e) { return json({ error: "ai_unavailable" }, 503); }
  }
};


