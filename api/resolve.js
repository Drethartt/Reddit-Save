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

function isAllowedRedditHost(hostname) {
  const host = hostname.replace(/^www\./, "").toLowerCase();
  return [
    "reddit.com",
    "old.reddit.com",
    "new.reddit.com",
    "redd.it",
    "i.redd.it",
    "preview.redd.it",
    "external-preview.redd.it",
    "v.redd.it"
  ].includes(host);
}

function decodeHtml(str = "") {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function buildJsonUrl(finalUrl) {
  const u = new URL(finalUrl);
  const path = u.pathname.replace(/\/$/, "");

  // already a comments URL
  if (path.includes("/comments/")) {
    return `https://www.reddit.com${path}.json?raw_json=1`;
  }

  // redd.it short links usually redirect before this point,
  // but keep a fallback
  const parts = path.split("/").filter(Boolean);
  if (u.hostname.replace(/^www\./, "") === "redd.it" && parts[0]) {
    return `https://www.reddit.com/comments/${parts[0]}.json?raw_json=1`;
  }

  throw new Error("Could not resolve this Reddit post");
}

async function resolveFinalUrl(inputUrl) {
  const res = await fetch(inputUrl, {
    redirect: "follow",
    headers: {
      "User-Agent": USER_AGENT
    }
  });

  if (!res.ok) {
    throw new Error("Failed to open Reddit link");
  }

  return res.url;
}

function getPostData(json) {
  const post = json?.[0]?.data?.children?.[0]?.data;
  if (!post) throw new Error("Post data not found");
  return post.crosspost_parent_list?.[0] || post;
}

function guessTypeFromUrl(url) {
  const lower = url.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".png") || lower.endsWith(".webp")) {
    return "image";
  }
  if (lower.endsWith(".gif")) {
    return "gif";
  }
  if (lower.endsWith(".mp4")) {
    return "video";
  }
  return "file";
}

function getExtension(url, fallback = "bin") {
  try {
    const pathname = new URL(url).pathname;
    const ext = pathname.split(".").pop();
    if (!ext || ext.length > 5) return fallback;
    return ext.toLowerCase();
  } catch {
    return fallback;
  }
}

function resolveGallery(post) {
  const galleryItems = post.gallery_data?.items;
  const mediaMeta = post.media_metadata;
  if (!galleryItems || !mediaMeta) return null;

  const items = galleryItems
    .map((item, index) => {
      const meta = mediaMeta[item.media_id];
      const src = decodeHtml(meta?.s?.u || "");
      if (!src) return null;
      return {
        index,
        type: "image",
        url: src,
        ext: getExtension(src, "jpg")
      };
    })
    .filter(Boolean);

  if (!items.length) return null;

  return {
    kind: "gallery",
    title: post.title || "Reddit gallery",
    postUrl: post.url ? decodeHtml(post.url) : "",
    mediaUrl: items[0].url,
    items,
    note: "Gallery detected"
  };
}

function resolvePostMedia(post, canonicalPostUrl) {
  const gallery = resolveGallery(post);
  if (gallery) {
    gallery.postUrl = canonicalPostUrl;
    return gallery;
  }

  const redditVideo =
    post.secure_media?.reddit_video ||
    post.media?.reddit_video ||
    post.preview?.reddit_video_preview;

  if (redditVideo?.fallback_url) {
    return {
      kind: post.is_video ? "video" : "gif",
      title: post.title || "Reddit video",
      postUrl: canonicalPostUrl,
      mediaUrl: decodeHtml(redditVideo.fallback_url),
      items: [],
      note: "Some Reddit videos may have separate audio"
    };
  }

  const directUrl = decodeHtml(post.url_overridden_by_dest || post.url || "");
  if (directUrl) {
    const directType = guessTypeFromUrl(directUrl);
    if (["image", "gif", "video"].includes(directType)) {
      return {
        kind: directType,
        title: post.title || "Reddit media",
        postUrl: canonicalPostUrl,
        mediaUrl: directUrl,
        items: [],
        note: ""
      };
    }
  }

  const previewImage = decodeHtml(post.preview?.images?.[0]?.source?.url || "");
  if (previewImage) {
    return {
      kind: "image",
      title: post.title || "Reddit image",
      postUrl: canonicalPostUrl,
      mediaUrl: previewImage,
      items: [],
      note: ""
    };
  }

  throw new Error("No downloadable media found in this post");
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
    const input = normalizeInput(req.query.url);
    const inputUrl = new URL(input);

    if (!isAllowedRedditHost(inputUrl.hostname)) {
      return res.status(400).json({ ok: false, error: "Only Reddit links are supported" });
    }

    // direct media link support
    const directHost = inputUrl.hostname.replace(/^www\./, "").toLowerCase();
    if (["i.redd.it", "preview.redd.it", "external-preview.redd.it"].includes(directHost)) {
      return res.status(200).json({
        ok: true,
        kind: guessTypeFromUrl(input),
        title: "Direct Reddit media",
        postUrl: input,
        mediaUrl: input,
        items: [],
        note: ""
      });
    }

    const finalUrl = await resolveFinalUrl(input);
    const jsonUrl = buildJsonUrl(finalUrl);

    const jsonRes = await fetch(jsonUrl, {
      headers: {
        "User-Agent": USER_AGENT
      },
      redirect: "follow"
    });

    if (!jsonRes.ok) {
      throw new Error("Failed to fetch Reddit post JSON");
    }

    const json = await jsonRes.json();
    const post = getPostData(json);
    const payload = resolvePostMedia(post, finalUrl);

    return res.status(200).json({
      ok: true,
      ...payload
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "Resolve failed"
    });
  }
}
