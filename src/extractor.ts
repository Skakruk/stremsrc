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
  sourceUrl: "https://vidsrc.xyz/embed",
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

  try {
    const embedRes = await fetchWithTimeout(url, { headers: getRandomizedHeaders(config.sourceUrl) });
    if (!embedRes.ok) {
        console.error(`[VidSrc] Failed to fetch embed page: ${url}`);
        return [];
    }
    const embedText = await embedRes.text();

    const { servers, title, baseDomain } = await vidSrc_serversLoad(embedText);

    const rcpFetchPromises = servers
        .filter(s => s.dataHash)
        .map(async (element) => {
            try {
                const rcpUrl = `${baseDomain}/rcp/${element.dataHash!}`;
                const rcpFetch = await fetchWithTimeout(rcpUrl, {
                    headers: getRandomizedHeaders(baseDomain),
                });

                if (!rcpFetch.ok) {
                    throw new Error(`[VidSrc] RCP fetch failed for ${rcpUrl} with status: ${rcpFetch.status}`);
                }

                const rcpText = await rcpFetch.text();
                const item = await vidSrc_rcpGrabber(rcpText);

                if (item && item.data) {
                    let streamUrl: string | null = item.data;
                    if (item.data.startsWith("/prorcp/")) {
                        streamUrl = await vidSrc_PRORCPhandler(item.data.replace("/prorcp/", ""), baseDomain);
                    }

                    // Defensive check: ensure streamUrl is a valid non-empty string
                    if (streamUrl && streamUrl.length > 0) {
                        const absoluteUrl = streamUrl.startsWith('http') ? streamUrl : new URL(streamUrl, baseDomain).toString();
                        const hlsData = await fetchAndParseHLS(absoluteUrl);
                        return {
                            name: `[VidSrc] ${title}`,
                            title: 'HLS Source',
                            stream: absoluteUrl,
                            referer: baseDomain,
                            hlsData: hlsData,
                            mediaId: id,
                        };
                    } else {
                        console.error(`[VidSrc] Stream URL was empty or invalid for hash: ${element.dataHash}`);
                    }
                }
            } catch (e) {
                console.error(`[VidSrc] Error processing server hash ${element.dataHash}:`, e);
                // Return null to allow Promise.all to continue
                return null;
            }
            return null;
        });

    const results = await Promise.all(rcpFetchPromises);
    return results.filter(Boolean) as APIResponse[];
  } catch (e) {
    console.error(`[VidSrc] A critical error occurred in scrapeVidSrc:`, e);
    return [];
  }
}

async function vidSrc_serversLoad(html: string): Promise<{ servers: VidSrc_Servers[]; title: string; baseDomain: string }> {
  const $ = cheerio.load(html);
  const servers: VidSrc_Servers[] = [];
  const title = $("title").text() ?? "";
  const iframeSrc = $("iframe").attr("src") ?? "";
  
  // Defensive check: ensure iframeSrc is valid before creating URL
  let baseDomain = config.defaultBaseDomain;
  if (iframeSrc && iframeSrc.length > 0) {
    try {
      baseDomain = new URL(iframeSrc.startsWith("//") ? "https:" + iframeSrc : iframeSrc).origin;
    } catch (e) {
      console.error("[VidSrc] Invalid iframe source URL, using default base domain.", e);
    }
  }

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
