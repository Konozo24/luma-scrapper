import 'dotenv/config';
import { checkForNewEvents } from './monitor';
import { scrapeNyalaLinkedInPosts } from './service/linkedinScraper';
import http from 'http';

const PORT = process.env.PORT;

const server = http.createServer(async (req, res) => {
    const url = req.url || '/';

    if ((req.method === 'GET' || req.method === 'HEAD') && url === '/trigger-scrape') {
        console.log("\nUptimeRobot triggered a Luma scrape!");
        await checkForNewEvents();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'Luma scrape completed successfully' }));
        return;
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && url === '/trigger-linkedin-scrape') {
        console.log("\nUptimeRobot triggered a LinkedIn scrape!");
        try {
            const summary = await scrapeNyalaLinkedInPosts();

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'LinkedIn scrape completed successfully',
                profileId: summary.profileId,
                collection: summary.collection,
                inserted: summary.inserted,
                existing: summary.existing,
                attempted: summary.attempted,
            }));
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown LinkedIn scrape error';
            console.error('LinkedIn scrape failed:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'LinkedIn scrape failed', error: message }));
        }
        return;
    }

    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Luma Monitor Web Service is running.');
});

server.listen(PORT, () => {
    console.log(`Web Service awake and listening on port ${PORT}`);
});