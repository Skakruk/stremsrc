/*
Original vidsrc.xyz extractor by github.com/cool-dev-guy
Modified and updated by github.com/theditor
Refactored for robustness, maintainability, and persistent caching.

Merged with 4KHDHub extractor logic.
Combined and converted to a unified TypeScript module by Gemini.
*/

import { ContentType } from "stremio-addon-sdk";
import * as cheerio from "cheerio";
import { fetchAndParseHLS, ParsedHLSStream } from "./hls-utils";

// --- LowDB Setup for Persistent Caching ---
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import path from 'path';

// Define the shape of your data
interface CacheEntry {
  id: string;
  data: APIResponse[];
  expiry: number; // Expiry timestamp
}

interface DbSchema {
  streams: CacheEntry[];
}

// Set up the database file (db.json)
const __dirname = path.resolve(path.dirname(''));
const file = path.join(__dirname, 'db.json');

const adapter = new JSONFile<DbSchema>(file);
const defaultData: DbSchema = { streams: [] };
const db = new Low(adapter, defaultData);
// --- End LowDB Setup ---


// --- Unified Configuration ---
const config = {
  // VidSrc Config
  sourceUrl: "https://vidsrc.xyz/embed",
  defaultBaseDomain: "https://cloudnestra.com",

  // 4KHDHub Config
  domainsUrl: 'https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json',
  tmdbApiKey: '439c478a771f35c05022f9feabcca01c', // Public key

  // General Config
  fetchTimeout: 15000, // 15 seconds, increased for potentially slower sources
  cacheTTL: 3600 * 1000, // 1 hour in milliseconds
  userAgents: [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0",
  ],
};

let cached4KHDHubDomains: any = null; // In-memory cache for 4KHDHub domains

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


// --- Main Orchestration and Caching Layer ---

/**
 * Main function to get stream content.
 * Checks for a valid cache entry before scraping from all sources.
 */
export async function getStreamContent(id: string, type: ContentType): Promise<APIResponse[]> {
    await db.read(); // Load the latest data from db.json

    const cacheKey = `${type}:${id}`;
    const now = Date.now();

    const cachedItem = db.data.streams.find(item => item.id === cacheKey);

    if (cachedItem && cachedItem.expiry > now) {
        console.log(`✅ Serving from cache for key: ${cacheKey}`);
        return cachedItem.data;
    }

    console.log(` Cache miss or expired for key: ${cacheKey}. Scraping from all sources...`);
    const apiResponse = await scrapeAllContent(id, type);

    if (apiResponse.length > 0) {
        const newItem: CacheEntry = {
            id: cacheKey,
            data: apiResponse,
            expiry: now + config.cacheTTL,
        };

        const itemIndex = db.data.streams.findIndex(item => item.id === cacheKey);
        if (itemIndex > -1) {
            db.data.streams[itemIndex] = newItem;
        } else {
            db.data.streams.push(newItem);
        }
        
        await db.write();
    }

    return apiResponse;
}

/**
 * Executes all scrapers in parallel and combines their results.
 */
async function scrapeAllContent(id: string, type: ContentType): Promise<APIResponse[]> {
    console.log(`Scraping all providers for ${type} ${id}`);
    
    const [vidSrcResult, khdHubResult] = await Promise.allSettled([
        scrapeVidSrc(id, type),
        scrape4KHDHub(id, type)
    ]);

    const allStreams: APIResponse[] = [];

    if (vidSrcResult.status === 'fulfilled') {
        allStreams.push(...vidSrcResult.value);
        console.log(`[VidSrc] Success: Found ${vidSrcResult.value.length} streams.`);
    } else {
        console.error("[VidSrc] Scraping failed:", vidSrcResult.reason);
    }

    if (khdHubResult.status === 'fulfilled') {
        allStreams.push(...khdHubResult.value);
        console.log(`[4KHDHub] Success: Found ${khdHubResult.value.length} streams.`);
    } else {
        console.error("[4KHDHub] Scraping failed:", khdHubResult.reason);
    }

    return allStreams;
}

// --- General Utilities ---
function getObject(id: string) {
  const arr = id.split(':');
  return { id: arr[0], season: arr[1] ? parseInt(arr[1], 10) : undefined, episode: arr[2] ? parseInt(arr[2], 10) : undefined };
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
    const url = type === "movie" ? `${config.sourceUrl}/movie/${id}` : `${config.sourceUrl}/tv/${getObject(id).id}/${getObject(id).season}-${getObject(id).episode}`;
    
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


// ===================================================================================
// --- 4KHDHUB.XYZ SCRAPER ---
// ===================================================================================

/**
 * Wrapper function to adapt the 4KHDHub scraper to the addon's interface.
 */
async function scrape4KHDHub(id: string, type: ContentType): Promise<APIResponse[]> {
    const { id: tmdbId, season, episode } = getObject(id);

    // The internal function returns streams in its own format
    const hubStreams = await khd_getStreamsInternal(tmdbId, type, season, episode);

    // Map the results to the unified APIResponse format
    return hubStreams.map(stream => ({
        name: stream.name,
        title: stream.title || 'Direct Source', // Use title for filename/size details
        url: stream.url,
        referer: new URL(stream.url).origin,
        mediaId: id,
    }));
}


// --- All logic from the second file, converted and adapted ---

// --- Core Logic ---
async function khd_getStreamsInternal(tmdbId: string, type: ContentType, season?: number, episode?: number): Promise<{ name: string; title: string; url: string; }[]> {
    try {
        console.log(`[4KHDHub] Starting search for TMDB ID: ${tmdbId}, Type: ${type}${season ? `, S: ${season}` : ''}${episode ? `, E: ${episode}` : ''}`);

        const tmdbType = type === 'series' ? 'tv' : 'movie';
        const tmdbDetails = await khd_getTMDBDetails(tmdbId, tmdbType);
        if (!tmdbDetails || !tmdbDetails.title) {
            console.log(`[4KHDHub] Could not fetch TMDB details for ID: ${tmdbId}`);
            return [];
        }
        console.log(`[4KHDHub] TMDB Details: ${tmdbDetails.title} (${tmdbDetails.year || 'N/A'})`);

        const searchQueries = khd_generateAlternativeQueries(tmdbDetails.title, tmdbDetails.original_title);
        let bestMatch: any = null;

        for (const query of searchQueries) {
            const searchResults = await khd_searchContent(query);
            if (searchResults.length > 0) {
                const match = khd_findBestMatch(searchResults, tmdbDetails.title, tmdbDetails.year);
                if (match && (!bestMatch || match.score > bestMatch.score)) {
                    bestMatch = match;
                }
            }
        }

        if (!bestMatch) {
            console.log(`[4KHDHub] No suitable match found for: ${tmdbDetails.title}`);
            return [];
        }
        console.log(`[4KHDHub] Using best match: ${bestMatch.title} with score ${bestMatch.score.toFixed(1)}`);

        const content = await khd_loadContent(bestMatch.url);
        let downloadLinks: string[] = [];

        if (type === 'movie') {
            downloadLinks = content.downloadLinks || [];
        } else if (type === 'series' && season && episode) {
            const targetEpisode = content.episodes?.find(ep => ep.season === season && ep.episode === episode);
            if (targetEpisode) {
                downloadLinks = targetEpisode.downloadLinks || [];
            }
        }

        if (downloadLinks.length === 0) {
            console.log(`[4KHDHub] No download links found for the requested content.`);
            return [];
        }

        const streamingLinks = await khd_extractStreamingLinks(downloadLinks);

        // URL Validation
        const validationPromises = streamingLinks.map(async (link) => {
            const isValid = await khd_validateUrl(link.url);
            return isValid ? link : null;
        });
        const validatedLinks = (await Promise.all(validationPromises)).filter(Boolean) as { name: string, title: string, url: string }[];
        
        console.log(`[4KHDHub] Validation complete: ${validatedLinks.length}/${streamingLinks.length} links are valid.`);
        return validatedLinks;

    } catch (error: any) {
        console.error(`[4KHDHub] Critical error in getStreamsInternal:`, error.message);
        return [];
    }
}

// --- Networking and HTML Parsing ---
async function khd_fetch(url: string, options: RequestInit = {}) {
    const defaultHeaders = { 'User-Agent': config.userAgents[0] };
    return fetchWithTimeout(url, { ...options, headers: { ...defaultHeaders, ...options.headers } });
}

async function khd_fetchWithCheerio(url: string, options: RequestInit = {}) {
    const res = await khd_fetch(url, options);
    if (!res.ok) throw new Error(`Failed to fetch ${url}, status: ${res.status}`);
    const text = await res.text();
    return { $: cheerio.load(text), body: text, response: res };
}

// --- Data Fetching and Processing ---
async function khd_getDomains(): Promise<any> {
    if (cached4KHDHubDomains) return cached4KHDHubDomains;
    try {
        const res = await khd_fetch(config.domainsUrl);
        const data = await res.json();
        cached4KHDHubDomains = data;
        return data;
    } catch (error) {
        console.error('[4KHDHub] Failed to fetch domains:', error);
        return null;
    }
}

async function khd_getTMDBDetails(tmdbId: string, mediaType: string) {
    try {
        const url = `https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${config.tmdbApiKey}`;
        const res = await khd_fetch(url);
        const data = await res.json();
        return {
            title: data.title || data.name,
            original_title: data.original_title || data.original_name,
            year: (data.release_date || data.first_air_date)?.split('-')[0] || null
        };
    } catch (error) {
        console.error(`[4KHDHub] Error fetching details from TMDB:`, error);
        return null;
    }
}

async function khd_searchContent(query: string): Promise<any[]> {
    const domains = await khd_getDomains();
    if (!domains || !domains['4khdhub']) throw new Error('4KHDHub domain not found');
    const baseUrl = domains['4khdhub'];
    const searchUrl = `${baseUrl}/?s=${encodeURIComponent(query)}`;
    
    const { $ } = await khd_fetchWithCheerio(searchUrl);
    const results: any[] = [];
    $('div.card-grid a').each((_, card) => {
        const $card = $(card);
        const yearMatch = ($card.find('.movie-card-meta').text() || '').match(/(19|20)\d{2}/);
        results.push({
            title: ($card.find('h3').text() || '').trim(),
            url: new URL($card.attr('href') || '', baseUrl).toString(),
            year: yearMatch ? parseInt(yearMatch[0]) : null
        });
    });
    return results;
}

async function khd_loadContent(url: string): Promise<{ downloadLinks?: string[], episodes?: any[] }> {
    const { $ } = await khd_fetchWithCheerio(url);
    const isMovie = $('div.mt-2 span.badge').text().includes('Movies');

    const downloadLinks = $('div.download-item a').map((_, a) => $(a).attr('href')).get().filter(Boolean);

    if (isMovie) {
        return { downloadLinks };
    } else {
        const episodes: any[] = [];
        $('div.episodes-list div.season-item').each((_, seasonEl) => {
            const seasonMatch = ($(seasonEl).find('div.episode-number').text() || '').match(/S?([1-9][0-9]*)/);
            const season = seasonMatch ? parseInt(seasonMatch[1]) : null;

            $(seasonEl).find('div.episode-download-item').each((_, episodeEl) => {
                const episodeMatch = ($(episodeEl).find('span.badge-psa').text() || '').match(/Episode-0*([1-9][0-9]*)/);
                const episode = episodeMatch ? parseInt(episodeMatch[1]) : null;
                const links = $(episodeEl).find('a').map((_, a) => $(a).attr('href')).get().filter(Boolean);
                if (season && episode && links.length > 0) {
                    episodes.push({ season, episode, downloadLinks: links });
                }
            });
        });
        return { episodes };
    }
}

async function khd_extractStreamingLinks(downloadLinks: string[]): Promise<{ name: string, title: string, url: string }[]> {
    const promises = downloadLinks.map(link => {
        if (link.toLowerCase().includes('id=')) {
            return khd_getRedirectLinks(link).then(resolved => resolved ? khd_processExtractorLink(resolved) : null);
        }
        return khd_processExtractorLink(link);
    });

    const results = await Promise.all(promises);
    return results.flat().filter(Boolean) as { name: string, title: string, url: string }[];
}

async function khd_processExtractorLink(link: string): Promise<any[] | null> {
    const lowerLink = link.toLowerCase();
    if (lowerLink.includes('hubdrive')) {
        return khd_extractHubDriveLinks(link);
    }
    if (lowerLink.includes('hubcloud')) {
        return khd_extractHubCloudLinks(link);
    }
    return null;
}

async function khd_getRedirectLinks(url: string): Promise<string | null> {
    try {
        const { body } = await khd_fetchWithCheerio(url);
        const regex = /s\('o','([A-Za-z0-9+/=]+)'|ck\('_wp_http_\d+','([^']+)'/g;
        let combined = '';
        let match;
        while ((match = regex.exec(body)) !== null) {
            combined += match[1] || match[2];
        }
        const decoded = Buffer.from(Buffer.from(Buffer.from(combined, 'base64').toString('utf-8'), 'base64').toString('utf-8'), 'base64').toString('utf-8');
        const json = JSON.parse(decoded);
        return Buffer.from(json.o || '', 'base64').toString('utf-8').trim();
    } catch (e) {
        return null;
    }
}

async function khd_extractHubCloudLinks(url: string): Promise<any[]> {
    const { $ } = await khd_fetchWithCheerio(url);
    const size = $('i#size').text() || '';
    const header = $('div.card-header').text() || '';
    const quality = (header.match(/(\d{3,4})[pP]/) || [])[1] || '1080';

    const promises = $('div.card-body h2 a.btn').map(async (_, button) => {
        const href = $(button).attr('href');
        const text = $(button).text();
        if (!href) return null;
        
        const filename = await khd_getFilenameFromUrl(href) || khd_cleanTitle(header);
        const title = `${filename}\n${size}`;
        const name = `[4KHDHub] ${text.trim()} | ${quality}p`;

        if (text.includes('BuzzServer')) {
            const res = await khd_fetch(`${href}/download`, { headers: { 'Referer': href }, redirect: 'manual' });
            const finalUrl = res.headers.get('hx-redirect') || res.headers.get('location');
            if (finalUrl) return { name, title, url: new URL(finalUrl, href).toString() };
        } else {
            return { name, title, url: href };
        }
        return null;
    }).get();
    
    return (await Promise.all(promises)).filter(Boolean);
}

async function khd_extractHubDriveLinks(url: string): Promise<any[]> {
    const { $ } = await khd_fetchWithCheerio(url);
    const href = $('.btn.btn-primary.btn-user.btn-success1.m-1').first().attr('href');
    if (!href) return [];
    
    if (href.toLowerCase().includes('hubcloud')) {
        return khd_extractHubCloudLinks(href);
    }
    const size = $('i#size').text() || '';
    const header = $('div.card-header').text() || '';
    const quality = (header.match(/(\d{3,4})[pP]/) || [])[1] || '1080';
    const filename = await khd_getFilenameFromUrl(href) || khd_cleanTitle(header);
    
    return [{ 
        name: `[4KHDHub] HubDrive | ${quality}p`,
        title: `${filename}\n${size}`,
        url: href 
    }];
}

// --- Utility Functions ---
async function khd_validateUrl(url: string): Promise<boolean> {
    try {
        const trustedHosts = ['pixeldrain.dev', 'r2.dev'];
        if (trustedHosts.some(host => new URL(url).hostname.includes(host))) return true;
        
        const res = await khd_fetch(url, { method: 'HEAD' });
        return res.ok || res.status === 206; // OK or Partial Content
    } catch (e) {
        return false;
    }
}

async function khd_getFilenameFromUrl(url: string): Promise<string | null> {
    try {
        const res = await khd_fetch(url, { method: 'HEAD' });
        const contentDisposition = res.headers.get('content-disposition');
        if (contentDisposition) {
            const match = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/i);
            if (match && match[1]) return decodeURIComponent(match[1].replace(/["']/g, ''));
        }
        const pathParts = new URL(url).pathname.split('/');
        return decodeURIComponent(pathParts[pathParts.length - 1]);
    } catch {
        return null;
    }
}

function khd_cleanTitle(title: string): string {
    return decodeURIComponent(title).split(/[.\-_]/).slice(-3).join('.');
}

function khd_normalizeTitle(title: string): string {
    return title.toLowerCase()
        .replace(/&/g, 'and')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function khd_calculateSimilarity(str1: string, str2: string): number {
    const s1 = khd_normalizeTitle(str1);
    const s2 = khd_normalizeTitle(str2);
    const words1 = new Set(s1.split(' '));
    const words2 = new Set(s2.split(' '));
    const intersection = new Set([...words1].filter(w => words2.has(w)));
    const union = new Set([...words1, ...words2]);
    return union.size === 0 ? 0 : intersection.size / union.size;
}

function khd_findBestMatch(results: any[], query: string, tmdbYear?: string): any {
    const queryYear = tmdbYear ? parseInt(tmdbYear) : null;
    const queryWithoutYear = query.replace(/\s*\((19|20)\d{2}\)\s*/, ' ').trim();

    const scoredResults = results.map(result => {
        const resultYear = result.year;
        const resultWithoutYear = result.title.replace(/\s*\((19|20)\d{2}\)\s*/, ' ').trim();
        let score = khd_calculateSimilarity(resultWithoutYear, queryWithoutYear) * 100;

        if (queryYear && resultYear) {
            if (queryYear === resultYear) score += 30; // Year matches
            else score -= 50; // Year mismatches, heavy penalty
        }
        return { ...result, score };
    });

    scoredResults.sort((a, b) => b.score - a.score);

    const bestResult = scoredResults[0];
    if (bestResult && bestResult.score > 40) { // Set a reasonable threshold
        return bestResult;
    }
    return null;
}

function khd_generateAlternativeQueries(title: string, originalTitle?: string | null): string[] {
    const queries = new Set<string>([title]);
    if (originalTitle) queries.add(originalTitle);
    queries.add(title.replace(/:/g, ''));
    queries.add(title.replace(/\s*\((19|20)\d{2}\)\s*/, '').trim());
    return Array.from(queries);
}

