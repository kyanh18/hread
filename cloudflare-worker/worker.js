/**
 * Cloudflare Worker Proxy for Hitomi.la
 * Handles CORS, Referer headers, gg.js URL resolution, and image streaming
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const pathname = url.pathname;

    try {
      if (pathname === '/api/parse') {
        return await handleParse(url);
      } else if (pathname === '/api/gallery') {
        return await handleGallery(url);
      } else if (pathname === '/api/image') {
        return await handleImage(url);
      } else if (pathname === '/api/ping') {
        return jsonResponse({ status: 'ok', time: Date.now() });
      }

      return jsonResponse({
        name: 'Hitomi Cloudflare Proxy',
        status: 'online',
        endpoints: ['/api/parse?url=...', '/api/gallery?id=...', '/api/image?url=...&id=...']
      });
    } catch (err) {
      return jsonResponse({ error: err.message || 'Internal Server Error' }, 500);
    }
  }
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

/**
 * Parses user input URL: single gallery OR collection (artist/search)
 */
async function handleParse(url) {
  const targetUrl = url.searchParams.get('url')?.trim();
  if (!targetUrl) {
    return jsonResponse({ error: 'Missing "url" query parameter' }, 400);
  }

  // Check if it's a direct ID or single gallery URL
  const singleIdMatch = targetUrl.match(/^(\d{5,9})$/) ||
    targetUrl.match(/\/reader\/(\d+)\.html/) ||
    targetUrl.match(/-(\d+)\.html/);

  if (singleIdMatch && !targetUrl.includes('/artist/') && !targetUrl.includes('/search.html')) {
    const galleryId = singleIdMatch[1];
    const info = await fetchGalleryInfo(galleryId);
    return jsonResponse({
      type: 'single',
      gallery: {
        id: galleryId,
        title: info.title || `Truyện #${galleryId}`,
        artists: (info.artists || []).map((a) => a.artist || a),
        language: info.language || 'unknown',
        pageCount: (info.files || []).length,
        hasFiles: Array.isArray(info.files) && info.files.length > 0,
      }
    });
  }

  // Otherwise, treat as artist / search page
  let fetchUrl = targetUrl;
  if (!fetchUrl.startsWith('http')) {
    fetchUrl = 'https://hitomi.la/' + fetchUrl.replace(/^\/+/, '');
  }

  const res = await fetch(fetchUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://hitomi.la/',
    }
  });

  if (!res.ok) {
    throw new Error(`Hitomi returned status ${res.status} when fetching page`);
  }

  const html = await res.text();

  // Extract gallery entries from HTML
  const galleries = [];
  const seenIds = new Set();

  // Regex to match gallery links: href="/(doujinshi|manga|gamecg|cg|anime)/slug-1234567.html"
  const galleryRegex = /href="\/((?:doujinshi|manga|gamecg|cg|anime)\/[^"]*?-(\d+)\.html)"/g;
  let match;

  while ((match = galleryRegex.exec(html)) !== null) {
    const relUrl = match[1];
    const id = match[2];

    if (!seenIds.has(id)) {
      seenIds.add(id);

      // Try to find title near this match
      let title = `Bộ truyện #${id}`;
      const contextSnippet = html.substring(Math.max(0, match.index - 300), Math.min(html.length, match.index + 500));
      const titleMatch = contextSnippet.match(new RegExp(`href="\\/${relUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>([^<]+)<\\/a>`)) ||
        contextSnippet.match(/<h1><a[^>]+>([^<]+)<\/a><\/h1>/);

      if (titleMatch && titleMatch[1]?.trim()) {
        title = titleMatch[1].trim();
      }

      galleries.push({
        id,
        url: `https://hitomi.la/${relUrl}`,
        title,
      });

      if (galleries.length >= 50) break; // limit to 50 max per page
    }
  }

  // Extract title / header from page
  let pageTitle = 'Danh sách truyện Hitomi';
  const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
  if (h1Match && h1Match[1]?.trim()) {
    pageTitle = h1Match[1].trim();
  }

  return jsonResponse({
    type: 'collection',
    sourceUrl: fetchUrl,
    pageTitle,
    count: galleries.length,
    galleries,
  });
}

/**
 * Fetches gallery details and computes image URLs via gg.js
 */
async function handleGallery(url) {
  const galleryId = url.searchParams.get('id');
  if (!galleryId) {
    return jsonResponse({ error: 'Missing "id" query parameter' }, 400);
  }

  const [galleryInfo, ggData] = await Promise.all([
    fetchGalleryInfo(galleryId),
    fetchGg(),
  ]);

  const files = galleryInfo.files || [];
  const images = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const directUrl = resolveHitomiUrl(file, ggData);
    images.push({
      order: i,
      name: file.name || `Trang ${i + 1}`,
      width: file.width,
      height: file.height,
      url: directUrl,
    });
  }

  // Thumbnail cover
  let coverUrl = images.length > 0 ? images[0].url : '';

  return jsonResponse({
    id: galleryId,
    title: galleryInfo.title || `Truyện #${galleryId}`,
    artists: (galleryInfo.artists || []).map((a) => a.artist || a),
    language: galleryInfo.language || 'unknown',
    coverUrl,
    pageCount: images.length,
    images,
  });
}

/**
 * Streams image from Hitomi with valid Referer header
 */
async function handleImage(url) {
  const targetUrl = url.searchParams.get('url');
  const galleryId = url.searchParams.get('id') || '0';

  if (!targetUrl) {
    return new Response('Missing "url" parameter', { status: 400, headers: CORS_HEADERS });
  }

  // Make sure URL is from hitomi CDN
  if (!targetUrl.includes('hitomi.la')) {
    return new Response('Invalid target domain', { status: 403, headers: CORS_HEADERS });
  }

  const imgRes = await fetch(targetUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': `https://hitomi.la/reader/${galleryId}.html`,
    }
  });

  if (!imgRes.ok) {
    return new Response(`Hitomi CDN error: ${imgRes.status}`, { status: imgRes.status, headers: CORS_HEADERS });
  }

  const contentType = imgRes.headers.get('content-type') || 'image/webp';
  return new Response(imgRes.body, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=604800, immutable',
    }
  });
}

// ==================== HELPERS ====================

async function fetchGalleryInfo(galleryId) {
  const res = await fetch(`https://ltn.hitomi.la/galleries/${galleryId}.js`, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Referer': 'https://hitomi.la/',
    }
  });

  if (!res.ok) {
    throw new Error(`Gallery #${galleryId} not found (HTTP ${res.status})`);
  }

  const text = await res.text();
  // Strip "var galleryinfo = "
  const jsonStr = text.replace(/^var\s+galleryinfo\s*=\s*/, '').replace(/;\s*$/, '');
  return JSON.parse(jsonStr);
}

async function fetchGg() {
  const res = await fetch('https://ltn.hitomi.la/gg.js', {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Referer': 'https://hitomi.la/',
    }
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch gg.js (HTTP ${res.status})`);
  }

  const script = await res.text();
  // Evaluate gg in isolated function
  const runGg = new Function(`
    var gg = {};
    ${script}
    return gg;
  `);

  return runGg();
}

/**
 * Resolves exact Hitomi image CDN URL using gg logic
 */
function resolveHitomiUrl(file, gg) {
  const hash = file.hash;
  const ext = file.haswebp ? 'webp' : (file.hasavif ? 'avif' : file.name.split('.').pop());

  // gg.s(h)
  const m = /(..)(.)$/.exec(hash);
  const s = parseInt(m[2] + m[1], 16).toString(10);

  // Subdomain calculation: gg.m(g)
  let subLetter = 'a';
  const subMatch = /\/[0-9a-f]{61}([0-9a-f]{2})([0-9a-f])/.exec(`/${hash}`);
  if (subMatch) {
    const g = parseInt(subMatch[2] + subMatch[1], 16);
    if (!isNaN(g) && typeof gg.m === 'function') {
      subLetter = String.fromCharCode(97 + gg.m(g));
    }
  }

  const b = gg.b || '';
  const dir = (ext === 'webp' || ext === 'avif') ? 'webp/' : '';

  return `https://${subLetter}a.hitomi.la/${dir}${b}${s}/${hash}.${ext}`;
}
