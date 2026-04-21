const USER_AGENT = "reddit-save/1.0 (+https://example.com)";

function withCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function normalizeInput(input) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("Missing url");
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function isAllowedMediaHost(hostname) {
  const host = hostname.replace(/^www\./, "").toLowerCase();
  return [
    "i.redd.it",
    "preview.redd.it",
    "external-preview.redd.it",
    "v.redd.it"
  ].includes(host);
}

function safeFilename(name) {
  return String(name || "reddit-media")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim() || "reddit-media";
}

function extensionFromContentType(contentType = "", fallback = "bin") {
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (type === "image/jpeg") return "jpg";
  if (type === "image/png") return "png";
  if (type === "image/webp") return "webp";
  if (type === "image/gif") return "gif";
  if (type === "video/mp4") return "mp4";
  return fallback;
}

export default async function handler(req, res) {
  withCors(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const mediaUrl = normalizeInput(req.query.url);
    const filenameBase = safeFilename(req.query.filename || "reddit-media");
    const parsed = new URL(mediaUrl);

    if (!isAllowedMediaHost(parsed.hostname)) {
      return res.status(400).json({ ok: false, error: "Unsupported media host" });
    }

    const upstream = await fetch(mediaUrl, {
      headers: {
        "User-Agent": USER_AGENT
      },
      redirect: "follow"
    });

    if (!upstream.ok) {
      return res.status(502).json({ ok: false, error: "Failed to fetch media" });
    }

    const contentType = upstream.headers.get("content-type") || "application/octet-stream";
    const ext = extensionFromContentType(contentType, "bin");
    const filename = `${filenameBase}.${ext}`;
    const buffer = Buffer.from(await upstream.arrayBuffer());

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-store");

    return res.status(200).send(buffer);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Download failed"
    });
  }
}
