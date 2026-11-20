/**
 * Cloudflare Worker Proxy for Hitomi.la
 * Supports modern gold-usergeneratedcontent.net CDN, Nozomi binary index decoding,
 * gg.js dynamic resolution, and image streaming with proper Referer.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

const LTN_DOMAIN = 'ltn.gold-usergeneratedcontent.net';
const IMAGE_DOMAIN = 'gold-usergeneratedcontent.net';

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
      console.error('Worker request error:', err);
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
 * Parses user input: single gallery OR collection (artist/search via Nozomi index)
 */
async function handleParse(url) {
  let targetUrl = url.searchParams.get('url')?.trim();
  if (!targetUrl) {
    return jsonResponse({ error: 'Missing "url" query parameter' }, 400);
  }

  // 1. Check if it's a direct ID or single gallery URL (e.g. 1234567, reader/1234567.html, doujinshi/...-1234567.html)
  const singleIdMatch = targetUrl.match(/^(\d{5,9})$/) ||
    targetUrl.match(/\/reader\/(\d+)\.html/) ||
    targetUrl.match(/-(?!english|all|japanese|korean|chinese|spanish|thai|vietnamese)(\d+)\.html/);

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

  // 2. Resolve search / artist query into Nozomi binary index
  const nozomiInfo = resolveNozomiQuery(targetUrl);
  if (nozomiInfo) {
    const { nozomiUrls, title, subtitle } = nozomiInfo;
    let galleryIds = [];

    // Try nozomi URLs in sequence
    for (const nUrl of nozomiUrls) {
      try {
        const res = await fetch(nUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://hitomi.la/',
          }
        });
        if (res.ok) {
          const buf = await res.arrayBuffer();
          galleryIds = parseNozomiBuffer(buf);
          if (galleryIds.length > 0) break;
        }
      } catch (e) {
        console.warn('Failed fetching nozomi:', nUrl, e.message);
      }
    }

    if (galleryIds.length > 0) {
      // Limit to top 30 galleries per batch to stay within Cloudflare Worker subrequest limits
      const topIds = galleryIds.slice(0, 30);
      const galleries = await fetchGalleriesMetadata(topIds);

      return jsonResponse({
        type: 'collection',
        sourceUrl: targetUrl,
        pageTitle: title,
        subtitle: `${subtitle} (Tìm thấy ${galleryIds.length} bộ, hiển thị ${galleries.length} bộ)`,
        totalFound: galleryIds.length,
        count: galleries.length,
        galleries,
      });
    }
  }

  // 3. Fallback: Fetch as raw HTML and parse links
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
  const galleries = [];
  const seenIds = new Set();
  const galleryRegex = /href="\/((?:doujinshi|manga|gamecg|cg|anime)\/[^"]*?-(\d+)\.html)"/g;
  let match;

  while ((match = galleryRegex.exec(html)) !== null) {
    const relUrl = match[1];
    const id = match[2];

    if (!seenIds.has(id)) {
      seenIds.add(id);
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

      if (galleries.length >= 30) break;
    }
  }

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
 * Helper to generate all possible Nozomi index URL variants for a given tag/artist/group
 * Hitomi CDN stores multi-word names with spaces (%20) in nozomi filenames,
 * but users and query links often format them with underscores (_) or pluses (+).
 */
function getNozomiVariants(type, rawName, lang = 'all') {
  const decoded = decodeURIComponent(rawName).trim().toLowerCase();
  const withSpaces = encodeURIComponent(decoded.replace(/[_\+]+/g, ' ').replace(/\s+/g, ' ').trim());
  const withUnderscores = encodeURIComponent(decoded.replace(/[\s\+]+/g, '_').trim());
  const exact = encodeURIComponent(decoded);

  const urls = [];
  const add = (n, l) => {
    const u = `https://${LTN_DOMAIN}/${type}/${n}-${l}.nozomi`;
    if (!urls.includes(u)) urls.push(u);
  };

  const targetLang = (lang || 'all').toLowerCase();
  if (targetLang !== 'all') {
    add(withSpaces, targetLang);
    add(withUnderscores, targetLang);
    add(exact, targetLang);
  }
  add(withSpaces, 'all');
  add(withUnderscores, 'all');
  add(exact, 'all');

  return urls;
}

/**
 * Resolves Hitomi URL or query into corresponding .nozomi binary index URLs
 */
function resolveNozomiQuery(inputUrl) {
  let decoded = decodeURIComponent(inputUrl).trim();

  // Normalize: artist page URL like https://hitomi.la/artist/dokuneko%20noil-english.html
  const artistUrlMatch = decoded.match(/\/artist\/([^\/?#]+?)(?:-([a-z0-9]+))?\.html/i);
  if (artistUrlMatch) {
    const artist = artistUrlMatch[1];
    const lang = (artistUrlMatch[2] || 'all').toLowerCase();
    const displayName = artist.replace(/[_\+]+/g, ' ');
    return {
      title: `Tác giả: ${displayName}`,
      subtitle: `Ngôn ngữ: ${lang}`,
      nozomiUrls: getNozomiVariants('artist', artist, lang)
    };
  }

  // Group page URL like https://hitomi.la/group/name-english.html
  const groupUrlMatch = decoded.match(/\/group\/([^\/?#]+?)(?:-([a-z0-9]+))?\.html/i);
  if (groupUrlMatch) {
    const group = groupUrlMatch[1];
    const lang = (groupUrlMatch[2] || 'all').toLowerCase();
    const displayName = group.replace(/[_\+]+/g, ' ');
    return {
      title: `Nhóm: ${displayName}`,
      subtitle: `Ngôn ngữ: ${lang}`,
      nozomiUrls: getNozomiVariants('group', group, lang)
    };
  }

  // Character page URL like https://hitomi.la/character/name-english.html
  const charUrlMatch = decoded.match(/\/character\/([^\/?#]+?)(?:-([a-z0-9]+))?\.html/i);
  if (charUrlMatch) {
    const charName = charUrlMatch[1];
    const lang = (charUrlMatch[2] || 'all').toLowerCase();
    const displayName = charName.replace(/[_\+]+/g, ' ');
    return {
      title: `Nhân vật: ${displayName}`,
      subtitle: `Ngôn ngữ: ${lang}`,
      nozomiUrls: getNozomiVariants('character', charName, lang)
    };
  }

  // Series page URL like https://hitomi.la/series/name-english.html
  const seriesUrlMatch = decoded.match(/\/series\/([^\/?#]+?)(?:-([a-z0-9]+))?\.html/i);
  if (seriesUrlMatch) {
    const seriesName = seriesUrlMatch[1];
    const lang = (seriesUrlMatch[2] || 'all').toLowerCase();
    const displayName = seriesName.replace(/[_\+]+/g, ' ');
    return {
      title: `Bộ truyện: ${displayName}`,
      subtitle: `Ngôn ngữ: ${lang}`,
      nozomiUrls: getNozomiVariants('series', seriesName, lang)
    };
  }

  // Tag page URL like https://hitomi.la/tag/female:name-english.html
  const tagUrlMatch = decoded.match(/\/tag\/([^\/?#]+?)(?:-([a-z0-9]+))?\.html/i);
  if (tagUrlMatch) {
    const tag = tagUrlMatch[1];
    const lang = (tagUrlMatch[2] || 'all').toLowerCase();
    const displayName = tag.replace(/[_\+]+/g, ' ');
    return {
      title: `Thẻ: ${displayName}`,
      subtitle: `Ngôn ngữ: ${lang}`,
      nozomiUrls: getNozomiVariants('tag', tag, lang)
    };
  }

  // Search query in URL e.g. search.html?artist%3Adokuneko_noil%20language%3Aenglish
  let queryString = decoded;
  if (queryString.includes('search.html?')) {
    queryString = queryString.split('search.html?')[1];
  }

  // Extract language filter
  const langMatch = queryString.match(/language:([^\s&]+)/i);
  const lang = (langMatch ? langMatch[1] : 'all').toLowerCase();

  // Extract artist filter
  const artistMatch = queryString.match(/artist:([^\s&]+)/i);
  if (artistMatch) {
    const artist = artistMatch[1];
    const displayName = artist.replace(/[_\+]+/g, ' ');
    return {
      title: `Tác giả: ${displayName}`,
      subtitle: `Ngôn ngữ: ${lang}`,
      nozomiUrls: getNozomiVariants('artist', artist, lang)
    };
  }

  // Extract group filter
  const grpMatch = queryString.match(/group:([^\s&]+)/i);
  if (grpMatch) {
    const grp = grpMatch[1];
    const displayName = grp.replace(/[_\+]+/g, ' ');
    return {
      title: `Nhóm: ${displayName}`,
      subtitle: `Ngôn ngữ: ${lang}`,
      nozomiUrls: getNozomiVariants('group', grp, lang)
    };
  }

  // Extract character filter
  const charSearchMatch = queryString.match(/character:([^\s&]+)/i);
  if (charSearchMatch) {
    const charName = charSearchMatch[1];
    const displayName = charName.replace(/[_\+]+/g, ' ');
    return {
      title: `Nhân vật: ${displayName}`,
      subtitle: `Ngôn ngữ: ${lang}`,
      nozomiUrls: getNozomiVariants('character', charName, lang)
    };
  }

  // Extract series filter
  const seriesSearchMatch = queryString.match(/series:([^\s&]+)/i);
  if (seriesSearchMatch) {
    const seriesName = seriesSearchMatch[1];
    const displayName = seriesName.replace(/[_\+]+/g, ' ');
    return {
      title: `Bộ truyện: ${displayName}`,
      subtitle: `Ngôn ngữ: ${lang}`,
      nozomiUrls: getNozomiVariants('series', seriesName, lang)
    };
  }

  // Extract tag filter
  const tMatch = queryString.match(/tag:([^\s&]+)/i);
  if (tMatch) {
    const tag = tMatch[1];
    const displayName = tag.replace(/[_\+]+/g, ' ');
    return {
      title: `Thẻ: ${displayName}`,
      subtitle: `Ngôn ngữ: ${lang}`,
      nozomiUrls: getNozomiVariants('tag', tag, lang)
    };
  }

  // Bare artist/term input (e.g. "dokuneko noil" or "jimpu6")
  if (!queryString.includes('/') && !queryString.includes('?') && queryString.length >= 2) {
    const term = queryString.trim();
    const displayName = term.replace(/[_\+]+/g, ' ');
    return {
      title: `Tác giả: ${displayName}`,
      subtitle: `Ngôn ngữ: english`,
      nozomiUrls: getNozomiVariants('artist', term, 'english')
    };
  }

  return null;
}

/**
 * Unpacks 32-bit big-endian integers from binary Nozomi file into gallery IDs
 */
function parseNozomiBuffer(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const ids = [];
  const total = view.byteLength;
  for (let offset = 0; offset < total; offset += 4) {
    const id = view.getInt32(offset, false); // false = Big-Endian
    if (id > 0) {
      ids.push(id.toString());
    }
  }
  return ids;
}

/**
 * Fetches metadata for an array of gallery IDs in parallel
 */
async function fetchGalleriesMetadata(ids) {
  const galleries = [];
  const chunkSize = 10;

  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const results = await Promise.allSettled(chunk.map((id) => fetchGalleryInfo(id)));

    for (let j = 0; j < results.length; j++) {
      const id = chunk[j];
      const r = results[j];
      if (r.status === 'fulfilled' && r.value) {
        const info = r.value;
        galleries.push({
          id,
          title: info.title || `Truyện #${id}`,
          artists: (info.artists || []).map((a) => a.artist || a),
          language: info.language || 'unknown',
          pageCount: (info.files || []).length,
          url: `https://hitomi.la/reader/${id}.html`,
        });
      } else {
        galleries.push({
          id,
          title: `Bộ truyện #${id}`,
          artists: [],
          url: `https://hitomi.la/reader/${id}.html`,
        });
      }
    }
  }

  return galleries;
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

  if (!targetUrl.includes(IMAGE_DOMAIN) && !targetUrl.includes('hitomi.la')) {
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

  const contentType = imgRes.headers.get('content-type') || 'image/avif';
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
  const res = await fetch(`https://${LTN_DOMAIN}/galleries/${galleryId}.js`, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Referer': 'https://hitomi.la/',
    }
  });

  if (!res.ok) {
    throw new Error(`Gallery #${galleryId} not found (HTTP ${res.status})`);
  }

  const text = await res.text();
  const jsonStr = text.replace(/^var\s+galleryinfo\s*=\s*/, '').replace(/;\s*$/, '');
  return JSON.parse(jsonStr);
}

async function fetchGg() {
  const res = await fetch(`https://${LTN_DOMAIN}/gg.js`, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Referer': 'https://hitomi.la/',
    }
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch gg.js (HTTP ${res.status})`);
  }

  const script = await res.text();

  // Parse b prefix
  const bMatch = script.match(/b:\s*['"]([^'"]+)['"]/);
  const bVal = bMatch ? bMatch[1] : '';

  // Parse case numbers for m function without eval / new Function
  const caseNumbers = new Set();
  const caseRegex = /case\s+(\d+):/g;
  let match;
  while ((match = caseRegex.exec(script)) !== null) {
    caseNumbers.add(parseInt(match[1], 10));
  }

  let oDefault = 1;
  const oMatch = script.match(/var\s+o\s*=\s*(\d+)/);
  if (oMatch) oDefault = parseInt(oMatch[1], 10);
  const oSwapped = oDefault === 1 ? 0 : 1;

  return {
    b: bVal,
    s: function(h) {
      const m = /(..)(.)$/.exec(h);
      return m ? parseInt(m[2] + m[1], 16).toString(10) : '';
    },
    m: function(g) {
      return caseNumbers.has(g) ? oSwapped : oDefault;
    }
  };
}

/**
 * Resolves exact Hitomi image CDN URL using gg logic and modern gold-usergeneratedcontent.net CDN
 */
function resolveHitomiUrl(file, gg) {
  const hash = file.hash;
  const ext = file.hasavif ? 'avif' : (file.haswebp ? 'webp' : file.name.split('.').pop());

  // gg.s(h)
  const m = /(..)(.)$/.exec(hash);
  const s = parseInt(m[2] + m[1], 16).toString(10);

  // Subdomain calculation: gg.m(g)
  let subPrefix = 'a1';
  const subMatch = /\/[0-9a-f]{61}([0-9a-f]{2})([0-9a-f])/.exec(`/${hash}`);
  if (subMatch) {
    const g = parseInt(subMatch[2] + subMatch[1], 16);
    const mVal = (typeof gg.m === 'function') ? gg.m(g) : 0;
    if (ext === 'webp') {
      subPrefix = 'w' + (1 + mVal);
    } else if (ext === 'avif') {
      subPrefix = 'a' + (1 + mVal);
    } else {
      subPrefix = String.fromCharCode(97 + mVal);
    }
  }

  const b = gg.b || '';
  return `https://${subPrefix}.${IMAGE_DOMAIN}/${b}${s}/${hash}.${ext}`;
}
