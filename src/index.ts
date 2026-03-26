import { checkForNewEvents } from './monitor';
import http from 'http';
import 'dotenv/config';

const PORT = process.env.PORT

const server = http.createServer(async (req, res) => {
    // When UptimeRobot pings this path, run the scraper
    if ((req.method === 'GET' || req.method === 'HEAD') && req.url === '/trigger-scrape') {
        console.log("\nUptimeRobot triggered a scrape!");
        await checkForNewEvents();
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: "Scrape completed successfully" }));
    } 
    // Default health check route
    else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end("Luma Monitor Web Service is running.");
    }
});

server.listen(PORT, () => {
    console.log(`Web Service awake and listening on port ${PORT}`);
    // Run once immediately on startup
    checkForNewEvents(); 
});