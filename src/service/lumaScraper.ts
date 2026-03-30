import { ApifyLumaEvent } from '../type';
import { mapLumaDataToApify } from '../util/mapper';

export async function scrapeCalendarAPI(calendarId: string): Promise<ApifyLumaEvent[]> {
    console.log(`Fetching API for calendar: ${calendarId}...`);
    
    let allRawEntries: any[] = [];
    let hasMore = true;
    let cursor = "";

    try {
        while (hasMore) {
            const baseUrl = `https://api2.luma.com/calendar/get-items?calendar_api_id=${calendarId}&pagination_limit=50&period=future`;
            const apiUrl = cursor ? `${baseUrl}&pagination_cursor=${cursor}` : baseUrl;
            
            const response = await fetch(apiUrl, {
                headers: { 
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                    "Accept": "application/json"
                }
            });

            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const data = await response.json();
            if (data.entries && data.entries.length > 0) {
                allRawEntries.push(...data.entries);
            }

            hasMore = data.has_more;
            cursor = data.next_cursor;

            if (hasMore) {
                console.log(`Fetching next page...`);
                await new Promise(res => setTimeout(res, 500)); 
            }
        }

        return allRawEntries.map(entry => mapLumaDataToApify(entry));

    } catch (error) {
        console.error(`❌ Failed to scrape ${calendarId}:`, error);
        return [];
    }
}


export async function getCalendarIdFromUrl(lumaUrl: string): Promise<string | null> {
    // If the user already provided a cal- ID, just return it
    if (lumaUrl.startsWith('cal-')) {
        return lumaUrl;
    }

    console.log(`Resolving URL to Calendar ID: ${lumaUrl}`);
    try {
        const response = await fetch(lumaUrl, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
        });
        
        const html = await response.text();
        
        // Luma embeds the calendar state in the page source. 
        // We can regex search for the calendar_api_id pattern (which usually starts with "cal-")
        const calIdMatch = html.match(/"calendar_api_id":"(cal-[a-zA-Z0-9]+)"/);
        
        if (calIdMatch && calIdMatch[1]) {
            console.log(`✅ Found Calendar ID: ${calIdMatch[1]}`);
            return calIdMatch[1];
        }
        
        console.error("❌ Could not find a calendar ID on this page.");
        return null;
    } catch (error) {
        console.error(`❌ Failed to resolve ${lumaUrl}:`, error);
        return null;
    }
}