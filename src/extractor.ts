/*
Original vidsrc.xyz extractor by github.com/cool-dev-guy
Modified and updated by github.com/theditor
Refactored for robustness, maintainability, and persistent caching.

Unified TypeScript module by Gemini.
*/

import { ContentType } from "stremio-addon-sdk";
import * as cheerio from "cheerio";
import { fetchAndParseHLS, ParsedHLSStream } from "./hls-utils";

// --- Unified Configuration ---
const config = {
  // VidSrc Config
  sourceUrl: "https://fmovies.gd/embed",
  defaultBaseDomain: "https://cloudnestra.com",

  // General Config
  fetchTimeout: 15000, // 15 seconds, increased for potentially slower sources
  userAgents: [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0",
  ],
};


// --- Type Definitions ---
interface APIResponse {
  name: string;
  title: string; // Used for descriptive text in Stremio, often includes filename/size
  stream?: string | null;
  url?: string | null; // Used for direct video links
  image?: string | null;
  mediaId?: string | null;
  referer?: string | null;
  hlsData?: ParsedHLSStream | null;
}

// --- Network & Header Utilities ---
async function fetchWithTimeout(url: string, options: RequestInit = {}, timeout = config.fetchTimeout) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(id);
  }
}

function getRandomizedHeaders(referer: string) {
    const userAgent = config.userAgents[Math.floor(Math.random() * config.userAgents.length)];
    return {
        "accept": "*/*",
        "accept-language": "en-US,en;q=0.9",
        "sec-fetch-dest": "iframe",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "cross-site",
        "Referer": `${referer}/`,
        "User-Agent": userAgent,
    };
}


// --- Main Orchestration Layer ---

/**
 * Main function to get stream content.
 * Scrapes directly from all sources without caching.
 */
export async function getStreamContent(id: string, type: ContentType): Promise<APIResponse[]> {
    console.log(`Scraping for ${type} ${id}...`);
    const apiResponse = await scrapeAllContent(id, type);
    return apiResponse;
}

/**
 * Executes all scrapers and combines their results.
 */
async function scrapeAllContent(id: string, type: ContentType): Promise<APIResponse[]> {
    const vidSrcResult = await scrapeVidSrc(id, type);
    console.log(`[VidSrc] Success: Found ${vidSrcResult.length} streams.`);
    return vidSrcResult;
}

// ===================================================================================
// --- VIDSRC.XYZ SCRAPER ---
// ===================================================================================

interface VidSrc_Servers {
  name: string | null;
  dataHash: string | null;
}
interface VidSrc_RCPResponse {
  metadata: { image: string };
  data: string;
}

async function scrapeVidSrc(id: string, type: ContentType): Promise<APIResponse[]> {
    const url = type === "movie" ? `${config.sourceUrl}/movie/${id}` : `${config.sourceUrl}/tv/${id.split(':')[0]}/${id.split(':')[1]}-${id.split(':')[2]}`;
    
    const embedRes = await fetchWithTimeout(url, { headers: getRandomizedHeaders(config.sourceUrl) });
    const embedText = await embedRes.text();
    
    const { servers, title, baseDomain } = await vidSrc_serversLoad(embedText);

    const rcpFetchPromises = servers
      .filter(s => s.dataHash)
      .map(element => fetchWithTimeout(`${baseDomain}/rcp/${element.dataHash!}`, {
          headers: getRandomizedHeaders(baseDomain)
      }));
    
    const rcpHttpResults = await Promise.allSettled(rcpFetchPromises);

    const prosrcrcp = await Promise.all(
      rcpHttpResults.map(async (result) => {
        if (result.status === 'fulfilled' && result.value.ok) {
          return vidSrc_rcpGrabber(await result.value.text());
        }
        if (result.status === 'rejected') {
          console.error("[VidSrc] A server fetch failed:", result.reason);
        }
        return null;
      })
    );

    const apiResponse: APIResponse[] = [];
    for (const item of prosrcrcp) {
      if (!item || !item.data) continue;

      let streamUrl: string | null = null;

      if (item.data.startsWith("/prorcp/")) {
        streamUrl = await vidSrc_PRORCPhandler(item.data.replace("/prorcp/", ""), baseDomain);
      } else if (item.data.includes(".m3u8") || item.data.startsWith("http")) {
        streamUrl = item.data;
      }

      if (streamUrl) {
        try {
          const absoluteUrl = streamUrl.startsWith('http') ? streamUrl : new URL(streamUrl, baseDomain).toString();
          const hlsData = await fetchAndParseHLS(absoluteUrl);
          
          apiResponse.push({
            name: `[VidSrc] ${title}`,
            title: 'HLS Source',
            stream: absoluteUrl,
            referer: baseDomain,
            hlsData: hlsData,
            mediaId: id,
          });
        } catch (e) {
          console.error(`[VidSrc] Failed to process stream URL: ${streamUrl}`, e);
        }
      }
    }
    return apiResponse;
}

async function vidSrc_serversLoad(html: string): Promise<{ servers: VidSrc_Servers[]; title: string; baseDomain: string }> {
  const $ = cheerio.load(html);
  const servers: VidSrc_Servers[] = [];
  const title = $("title").text() ?? "";
  const iframeSrc = $("iframe").attr("src") ?? "";
  const baseDomain = iframeSrc ? new URL(iframeSrc.startsWith("//") ? "https:" + iframeSrc : iframeSrc).origin : config.defaultBaseDomain;
  
  $(".serversList .server").each((_, element) => {
    const server = $(element);
    servers.push({
      name: server.text().trim(),
      dataHash: server.attr("data-hash") ?? null,
    });
  });

  return { servers, title, baseDomain };
}

async function vidSrc_PRORCPhandler(prorcp: string, baseDomain: string): Promise<string | null> {
  try {
    const prorcpFetch = await fetchWithTimeout(`${baseDomain}/prorcp/${prorcp}`, {
      headers: getRandomizedHeaders(baseDomain),
    });
    if (!prorcpFetch.ok) return null;
    
    const prorcpResponse = await prorcpFetch.text();
    const regex = /file:\s*['"]([^'"]*)['"]/gm;
    const match = regex.exec(prorcpResponse);
    return match && match[1] ? match[1] : null;
  } catch (error) {
    console.error("[VidSrc] PRORCPhandler error:", error);
    return null;
  }
}

async function vidSrc_rcpGrabber(html: string): Promise<VidSrc_RCPResponse | null> {
  const regex = /src:\s*['"]([^'"]*)['"]/;
  const match = html.match(regex);
  if (!match) return null;
  return {
    metadata: { image: "" },
    data: match[1],
  };
}
