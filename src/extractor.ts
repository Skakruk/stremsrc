/**
 * @file Extractor for vidsrc.xyz
 * @description This module scrapes stream links for movies and TV shows with a focus on robustness and clear logging.
 */

import * as cheerio from "cheerio";
import { ContentType } from "stremio-addon-sdk";
// Assuming hls-utils provides HLS parsing functionality.
import { fetchAndParseHLS, ParsedHLSStream } from "./hls-utils";

// --- Configuration ---
const config = {
  sourceUrl: "https://vidsrc.xyz/embed",
  defaultBaseDomain: "https://cloudnestra.com",
  fetchTimeout: 15000, // 15 seconds
  userAgents: [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  ],
};

// --- Type Definitions ---
interface StreamResult {
  name: string;
  title: string;
  stream: string;
  referer: string;
  hlsData?: ParsedHLSStream | null;
}

interface Server {
  name: string;
  dataHash: string;
}

// --- Utilities ---

/**
 * Custom error class for detailed debugging.
 */
class ScraperError extends Error {
  constructor(message: string, public context?: Record<string, any>) {
    super(message);
    this.name = "ScraperError";
  }
}

/**
 * Fetches a URL with a timeout.
 */
async function fetchWithTimeout(url: string, options: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.fetchTimeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ScraperError(`Request timed out`, { url });
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Generates randomized request headers to mimic a real browser.
 */
function getRandomizedHeaders(referer: string): Record<string, string> {
  const userAgent = config.userAgents[Math.floor(Math.random() * config.userAgents.length)];
  return {
    "accept": "*/*",
    "accept-language": "en-US,en;q=0.9",
    "Referer": `${referer}/`,
    "User-Agent": userAgent,
  };
}

/**
 * Validates if a given value is a usable URL string.
 */
function isValidUrl(url: any): url is string {
  return typeof url === 'string' && url.trim() !== '' && (url.startsWith('http') || url.startsWith('//'));
}

// --- Scraper Core Logic ---

/**
 * Parses the initial embed page to find server hashes and metadata.
 */
async function fetchAndParseServers(html: string): Promise<{ servers: Server[]; title: string; baseDomain: string }> {
  const $ = cheerio.load(html);
  const title = $("title").text().trim();
  const iframeSrc = $("iframe").attr("src") || "";

  let baseDomain = config.defaultBaseDomain;
  if (isValidUrl(iframeSrc)) {
    try {
      baseDomain = new URL(iframeSrc.startsWith("//") ? `https:${iframeSrc}` : iframeSrc).origin;
    } catch (e) {
      console.warn(`[VidSrc] Could not parse iframe URL '${iframeSrc}', falling back to default domain.`);
    }
  }

  const servers: Server[] = $(".serversList .server")
    .map((_, el) => {
      const element = $(el);
      const name = element.text().trim();
      const dataHash = element.attr("data-hash");
      return dataHash ? { name, dataHash } : null;
    })
    .get()
    .filter((s): s is Server => s !== null);
    
  return { servers, title, baseDomain };
}

/**
 * Extracts the stream source URL from a server's RCP (Remote Content Protocol) page.
 */
async function getStreamUrlFromServer(server: Server, baseDomain: string): Promise<string | null> {
  const rcpUrl = `${baseDomain}/rcp/${server.dataHash}`;
  const rcpRes = await fetchWithTimeout(rcpUrl, { headers: getRandomizedHeaders(baseDomain) });
  if (!rcpRes.ok) throw new ScraperError("Failed to fetch RCP page", { rcpUrl, status: rcpRes.status });
  
  const rcpText = await rcpRes.text();
  const initialSrcMatch = rcpText.match(/src:\s*['"]([^'"]*)['"]/);
  let streamUrl = initialSrcMatch ? initialSrcMatch[1] : null;

  if (!streamUrl) return null;
  
  if (streamUrl.startsWith("/prorcp/")) {
    const prorcpUrl = `${baseDomain}${streamUrl}`;
    const prorcpRes = await fetchWithTimeout(prorcpUrl, { headers: getRandomizedHeaders(baseDomain) });
    if (!prorcpRes.ok) return null; // Silently fail if the final link can't be fetched
    
    const prorcpText = await prorcpRes.text();
    const finalFileMatch = prorcpText.match(/file:\s*['"]([^'"]*)['"]/);
    streamUrl = finalFileMatch ? finalFileMatch[1] : null;
  }
  
  return streamUrl;
}

/**
 * Processes a single server to get a fully-formed stream result.
 */
async function processServer(server: Server, baseDomain: string, title: string): Promise<StreamResult | null> {
  try {
    const streamUrl = await getStreamUrlFromServer(server, baseDomain);

    if (!isValidUrl(streamUrl)) {
      console.warn(`[VidSrc] Invalid stream URL found for hash ${server.dataHash}: '${streamUrl || 'empty'}'`);
      return null;
    }
    
    const absoluteUrl = streamUrl.startsWith("//") ? `https:${streamUrl}` : streamUrl;
    const hlsData = await fetchAndParseHLS(absoluteUrl);
    
    return {
      name: `[VidSrc] ${title}`,
      title: hlsData ? `HLS - ${hlsData.highestQuality.height}p` : 'HLS Source',
      stream: absoluteUrl,
      referer: baseDomain,
      hlsData,
    };
  } catch (error) {
    const context = error instanceof ScraperError ? error.context : {};
    console.error(`[VidSrc] Failed to process server ${server.name} (${server.dataHash}): ${error instanceof Error ? error.message : 'Unknown error'}`, context);
    return null;
  }
}

// --- Main Export ---

/**
 * The main function to get stream content for a movie or series.
 */
export async function getStreamContent(id: string, type: ContentType): Promise<StreamResult[]> {
  const [imdbId, season, episode] = id.split(':');
  const url = type === "movie" 
    ? `${config.sourceUrl}/movie/${imdbId}` 
    : `${config.sourceUrl}/tv/${imdbId}/${season}-${episode}`;
  
  console.log(`🔎 Scraping for ${type}: ${id}`);

  try {
    // 1. Fetch the main embed page
    const embedRes = await fetchWithTimeout(url, { headers: getRandomizedHeaders(config.sourceUrl) });
    if (!embedRes.ok) throw new ScraperError("Failed to fetch initial embed page", { url, status: embedRes.status });
    const embedHtml = await embedRes.text();

    // 2. Parse out servers and metadata
    const { servers, title, baseDomain } = await fetchAndParseServers(embedHtml);
    if (servers.length === 0) {
      console.warn(`[VidSrc] No servers found on page for ${id}.`);
      return [];
    }
    console.log(`[VidSrc] Found ${servers.length} potential servers for "${title}"`);

    // 3. Process all servers in parallel, with a small delay between starting each one
    const streamPromises = servers.map((server, index) => 
      new Promise(resolve => setTimeout(() => resolve(processServer(server, baseDomain, title)), index * 200))
    );
    const results = await Promise.all(streamPromises);

    // 4. Filter out any null results from failed attempts
    const validStreams = results.filter((r): r is StreamResult => r !== null);
    console.log(`✅ [VidSrc] Successfully extracted ${validStreams.length} valid streams.`);
    return validStreams;

  } catch (error) {
    const context = error instanceof ScraperError ? error.context : {};
    console.error(`❌ [VidSrc] Critical error scraping for ${id}: ${error instanceof Error ? error.message : 'Unknown error'}`, context);
    return []; // Always return an array, even on failure
  }
}
