"use strict";
/**
 * @file Extractor for vidsrc.xyz
 * @description This module scrapes stream links for movies and TV shows with a focus on robustness and clear logging.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getStreamContent = getStreamContent;
const cheerio = __importStar(require("cheerio"));
// Assuming hls-utils provides HLS parsing functionality.
const hls_utils_1 = require("./hls-utils");
// --- Configuration ---
const config = {
    sourceUrl: 'https://vidsrc.xyz/embed',
    defaultBaseDomain: 'https://cloudnestra.com',
    fetchTimeout: 15000, // 15 seconds
    userAgents: [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    ],
};
// --- Utilities ---
/**
 * Custom error class for detailed debugging.
 */
class ScraperError extends Error {
    constructor(message, context) {
        super(message);
        this.context = context;
        this.name = 'ScraperError';
    }
}
/**
 * Fetches a URL with a timeout.
 */
function fetchWithTimeout(url_1) {
    return __awaiter(this, arguments, void 0, function* (url, options = {}) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), config.fetchTimeout);
        try {
            return yield fetch(url, Object.assign(Object.assign({}, options), { signal: controller.signal }));
        }
        catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                throw new ScraperError(`Request timed out`, { url });
            }
            throw error;
        }
        finally {
            clearTimeout(timeoutId);
        }
    });
}
/**
 * Generates randomized request headers to mimic a real browser.
 */
function getRandomizedHeaders(referer) {
    const userAgent = config.userAgents[Math.floor(Math.random() * config.userAgents.length)];
    return {
        'accept': '*/*',
        'accept-language': 'en-US,en;q=0.9',
        'Referer': `${referer}/`,
        'User-Agent': userAgent,
    };
}
/**
 * Validates if a given value is a usable URL string.
 */
function isValidUrl(url) {
    return typeof url === 'string' && url.trim() !== '' && (url.startsWith('http') || url.startsWith('//'));
}
// --- Scraper Core Logic ---
/**
 * Parses the initial embed page to find server hashes and metadata.
 */
function fetchAndParseServers(html) {
    return __awaiter(this, void 0, void 0, function* () {
        const $ = cheerio.load(html);
        const title = $('title').text().trim();
        const iframeSrc = $('iframe').attr('src') || '';
        let baseDomain = config.defaultBaseDomain;
        if (isValidUrl(iframeSrc)) {
            try {
                baseDomain = new URL(iframeSrc.startsWith('//') ? `https:${iframeSrc}` : iframeSrc).origin;
            }
            catch (e) {
                console.warn(`[VidSrc] Could not parse iframe URL '${iframeSrc}', falling back to default domain.`);
            }
        }
        const servers = $('.serversList .server')
            .map((_, el) => {
            const element = $(el);
            const name = element.text().trim();
            const dataHash = element.attr('data-hash');
            return dataHash ? { name, dataHash } : null;
        })
            .get()
            .filter((s) => s !== null);
        return { servers, title, baseDomain };
    });
}
/**
 * Extracts the stream source URL from a server's RCP (Remote Content Protocol) page.
 */
function getStreamUrlFromServer(server, baseDomain) {
    return __awaiter(this, void 0, void 0, function* () {
        const rcpUrl = `${baseDomain}/rcp/${server.dataHash}`;
        const rcpRes = yield fetchWithTimeout(rcpUrl, { headers: getRandomizedHeaders(baseDomain) });
        if (!rcpRes.ok)
            throw new ScraperError('Failed to fetch RCP page', { rcpUrl, status: rcpRes.status });
        const rcpText = yield rcpRes.text();
        const initialSrcMatch = rcpText.match(/src:\s*['"]([^'"]*)['"]/);
        let streamUrl = initialSrcMatch ? initialSrcMatch[1] : null;
        if (!streamUrl)
            return null;
        if (streamUrl.startsWith('/prorcp/')) {
            const prorcpUrl = `${baseDomain}${streamUrl}`;
            const prorcpRes = yield fetchWithTimeout(prorcpUrl, { headers: getRandomizedHeaders(baseDomain) });
            if (!prorcpRes.ok)
                return null; // Silently fail if the final link can't be fetched
            const prorcpText = yield prorcpRes.text();
            const finalFileMatch = prorcpText.match(/file:\s*['"]((?:https?:)?\/\/[^\/'"]+\/pl\/[^'"]+?\/master\.m3u8(?:\?[^\s'"]*)?)['"]/i);
            streamUrl = finalFileMatch ? finalFileMatch[1] : null;
        }
        return streamUrl;
    });
}
/**
 * Processes a single server to get a fully-formed stream result.
 */
function processServer(server, baseDomain, title) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const streamUrl = yield getStreamUrlFromServer(server, baseDomain);
            if (!isValidUrl(streamUrl)) {
                console.warn(`[VidSrc] Invalid stream URL found for hash ${server.dataHash}: '${streamUrl || 'empty'}'`);
                return null;
            }
            const absoluteUrl = streamUrl.startsWith('//') ? `https:${streamUrl}` : streamUrl;
            const hlsData = yield (0, hls_utils_1.fetchAndParseHLS)(absoluteUrl);
            return {
                name: `[VidSrc] ${title}`,
                title: hlsData ? `HLS - xxxp` : 'HLS Source',
                stream: absoluteUrl,
                referer: baseDomain,
                hlsData,
            };
        }
        catch (error) {
            const context = error instanceof ScraperError ? error.context : {};
            console.error(`[VidSrc] Failed to process server ${server.name} (${server.dataHash}): ${error instanceof Error ? error.message : 'Unknown error'}`, context);
            return null;
        }
    });
}
// --- Main Export ---
/**
 * The main function to get stream content for a movie or series.
 */
function getStreamContent(id, type) {
    return __awaiter(this, void 0, void 0, function* () {
        const [imdbId, season, episode] = id.split(':');
        const url = type === 'movie'
            ? `${config.sourceUrl}/movie/${imdbId}`
            : `${config.sourceUrl}/tv/${imdbId}/${season}-${episode}`;
        console.log(`🔎 Scraping for ${type}: ${id}`);
        try {
            // 1. Fetch the main embed page
            const embedRes = yield fetchWithTimeout(url, { headers: getRandomizedHeaders(config.sourceUrl) });
            if (!embedRes.ok)
                throw new ScraperError('Failed to fetch initial embed page', {
                    url,
                    status: embedRes.status
                });
            const embedHtml = yield embedRes.text();
            // 2. Parse out servers and metadata
            const { servers, title, baseDomain } = yield fetchAndParseServers(embedHtml);
            if (servers.length === 0) {
                console.warn(`[VidSrc] No servers found on page for ${id}.`);
                return [];
            }
            console.log(`[VidSrc] Found ${servers.length} potential servers for "${title}"`);
            // 3. Process all servers in parallel, with a small delay between starting each one
            const streamPromises = servers.map((server, index) => new Promise(resolve => setTimeout(() => resolve(processServer(server, baseDomain, title)), index * 200)));
            const results = yield Promise.all(streamPromises);
            // 4. Filter out any null results from failed attempts
            const validStreams = results.filter((r) => r !== null);
            console.log(`✅ [VidSrc] Successfully extracted ${validStreams.length} valid streams.`);
            return validStreams;
        }
        catch (error) {
            const context = error instanceof ScraperError ? error.context : {};
            console.error(`❌ [VidSrc] Critical error scraping for ${id}: ${error instanceof Error ? error.message : 'Unknown error'}`, context);
            return []; // Always return an array, even on failure
        }
    });
}
