import { addonBuilder, Manifest, Stream } from 'stremio-addon-sdk';
import { getStreamContent } from './extractor';
import pkg from '../package.json';

const manifest: Manifest = {
    id: 'xyz.theditor.stremsrc',
    version: pkg.version,
    catalogs: [],
    resources: [
        {
            name: 'stream',
            types: ['movie', 'series'],
            idPrefixes: ['tt'],
        },
    ],
    types: ['movie', 'series'],
    name: 'stremsrc',
    description: 'A VidSRC extractor for stremio',
};

const builder = new addonBuilder(manifest);

builder.defineStreamHandler(
    async ({
               id,
               type,
           }): Promise<{
        streams: Stream[];
    }> => {
        try {
            const res = await getStreamContent(id, type);

            if (!res) {
                return { streams: [] };
            }

            let streams: Stream[] = [];
            for (const st of res) {
                if (st.stream == null) continue;

                // If we have HLS data with multiple qualities, create separate streams
                if (st.hlsData && st.hlsData.qualities.length > 0) {
                    // Add the master playlist as "Auto Quality"
                    streams.push({
                        title: `${st.name ?? 'Unknown'} - Auto Quality`,
                        url: st.stream,
                        behaviorHints: { notWebReady: true, group: 'stremsrc-auto' },
                    });

                    // Add individual quality streams
                    for (const quality of st.hlsData.qualities) {
                        streams.push({
                            title: `${st.name ?? 'Unknown'} - ${quality.title}`,
                            url: quality.url,
                            behaviorHints: { notWebReady: true, group: `stremsrc-${quality.title}` },
                        });
                    }
                } else {
                    // Fallback to original behavior if no HLS data
                    streams.push({
                        title: st.name ?? 'Unknown',
                        url: st.stream,
                        behaviorHints: { notWebReady: true },
                    });
                }
            }
            return { streams: streams };
        } catch (error) {
            console.error('Stream extraction failed:', error);
            return { streams: [] };
        }
    }
);

export default builder.getInterface();
