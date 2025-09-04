/*
written by github.com/cool-dev-guy
modified and updated by github.com/theditor
STABILIZED VERSION
*/

import { ContentType } from "stremio-addon-sdk";
import * as cheerio from "cheerio";
import { fetchAndParseHLS, ParsedHLSStream } from "./hls-utils";

// This is a default/fallback, but should not be mutated during a request.
const SOURCE_URL = "https://vidsrc.xyz/embed";

// Array of realistic user agents to rotate through (your implementation is good)
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
];

// Your header generation functions are well-structured. No changes needed here.
function getSecChUa(userAgent: string): string {
    if (userAgent.includes('Chrome') && userAgent.includes('Edg')) return '"Chromium";v="128", "Not;A=Brand";v="24", "Microsoft Edge";v="128"';
    if (userAgent.includes('Chrome') && !userAgent.includes('Edg')) return '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"';
    return '';
}

function getSecChUaPlatform(userAgent: string): string {
    if (userAgent.includes('Windows')) return '"Windows"';
    if (userAgent.includes('Macintosh')) return '"macOS"';
    if (userAgent.includes('Linux')) return '"Linux"';
    return '"Windows"';
}

function getRandomUserAgent(): string {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function getRandomizedHeaders(referer: string) {
    const userAgent = getRandomUserAgent();
    const secChUa = getSecChUa(userAgent);
    const secChUaPlatform = getSecChUaPlatform(userAgent);
    
    const headers: Record<string, string> = {
        "accept": "*/*",
        "accept-language": "en-US,en;q=0.9",
        "priority": "u=1",
        "sec-ch-ua-mobile": "?0",
        "sec-fetch-dest": "iframe",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "cross-site",
        "Referer": referer,
        "User-Agent": userAgent,
    };

    if (secChUa) {
        headers["sec-ch-ua"] = secChUa;
        headers["sec-ch-ua-platform"] = secChUaPlatform;
    }

    return headers;
}

// Interfaces remain the same
interface Servers {
  name: string | null;
  dataHash: string | null;
}
interface APIResponse {
  name: string | null;
  image: string | null;
  mediaId: string | null;
  stream: string | null;
  referer: string;
  hlsData?: ParsedHLSStream | null;
}

// MODIFIED: This function now returns the base domain it finds.
async function serversLoad(html: string): Promise<{ servers: Servers[]; title: string; basedom: string }> {
  const $ = cheerio.load(html);
  const servers: Servers[] = [];
  const title = $("title").text() ?? "";
  
  // Find the base domain for this specific request
  const iframeSrc = $("iframe").attr("src") ?? "";
  const basedom = new URL(iframeSrc.startsWith("//") ? "https:" + iframeSrc : iframeSrc).origin;

  if (!basedom) {
      throw new Error("Could not determine the base domain from the iframe source.");
  }

  $(".serversList .server").each((_, element) => {
    const server = $(element);
    servers.push({
      name: server.text().trim(),
      dataHash: server.attr("data-hash") ?? null,
    });
  });

  return { servers, title, basedom };
}

// MODIFIED: This function now accepts the base domain as a parameter.
async function PRORCPhandler(prorcp: string, basedom: string, referer: string): Promise<string | null> {
  // Use a try-catch here as it's a specific, isolated failure point.
  try {
    const prorcpFetch = await fetch(`${basedom}/prorcp/${prorcp}`, {
      // Use a timeout to prevent requests from hanging indefinitely
      signal: AbortSignal.timeout(8000), // 8 seconds
      headers: {
        ...getRandomizedHeaders(referer),
        "accept": "*/*",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
      },
    });

    if (!prorcpFetch.ok) return null;
    
    const prorcpResponse = await prorcpFetch.text();
    const match = /file:\s*'([^']*)'/.exec(prorcpResponse);
    return match?.[1] || null;

  } catch (error) {
    console.error(`Error in PRORCPhandler for ${prorcp}:`, error);
    return null;
  }
}

// Simplified this function slightly.
async function rcpGrabber(html: string): Promise<string | null> {
  const match = /src:\s*'([^']*)'/.exec(html);
  return match?.[1] || null;
}

// Your utility functions are fine
function getObject(id: string) {
  const [mediaId, season, episode] = id.split(':');
  return { id: mediaId, season, episode };
}

export function getUrl(id: string, type: ContentType) {
  if (type === "movie") {
    return `${SOURCE_URL}/movie/${id}`;
  }
  const obj = getObject(id);
  return `${SOURCE_URL}/tv/${obj.id}/${obj.season}-${obj.episode}`;
}

// REWRITTEN: The main logic with stability and performance fixes.
async function getStreamContent(id: string, type: ContentType): Promise<APIResponse[]> {
  // **FIX 2: Add a top-level try-catch block to prevent crashes**
  try {
    const url = getUrl(id, type);
    const embed = await fetch(url, { 
      signal: AbortSignal.timeout(10000), // 10 second timeout
      headers: getRandomizedHeaders(url) 
    });
    if (!embed.ok) {
        console.error(`Failed to fetch initial embed page: ${embed.status}`);
        return [];
    }
    const embedResp = await embed.text();

    // **FIX 1: Capture the request-specific base domain, don't use a global**
    const { servers, title, basedom } = await serversLoad(embedResp);

    const apiResponse: APIResponse[] = [];

    // **FIX 3: Process servers sequentially instead of all at once**
    for (const server of servers) {
      if (!server.dataHash) continue;

      try {
        const rcpResponse = await fetch(`${basedom}/rcp/${server.dataHash}`, {
          signal: AbortSignal.timeout(8000), // 8 second timeout
          headers: {
            ...getRandomizedHeaders(basedom + '/'),
          }
        });
        if (!rcpResponse.ok) continue;

        const rcpData = await rcpGrabber(await rcpResponse.text());
        if (!rcpData || !rcpData.startsWith("/prorcp/")) continue;
        
        const streamUrl = await PRORCPhandler(rcpData.replace("/prorcp/", ""), basedom, basedom + '/');
        
        if (streamUrl) {
          const hlsData = await fetchAndParseHLS(streamUrl);
          apiResponse.push({
            name: title,
            image: null, // You can extract this if needed
            mediaId: id,
            stream: streamUrl,
            referer: basedom,
            hlsData: hlsData,
          });
          
          // Optional: If you only need one stream, you can stop here.
          // This makes your addon much faster for the end-user.
          // return apiResponse; 
        }
      } catch (loopError) {
          // Log the error for this specific server and continue to the next one.
          console.error(`Failed to process server ${server.name} (${server.dataHash}):`, loopError);
      }
    }
    return apiResponse;
  } catch (error) {
    console.error(`FATAL: A critical error occurred in getStreamContent for ID ${id}:`, error);
    // Return an empty array to signify failure without crashing the whole application.
    return [];
  }
}

export { getStreamContent };
