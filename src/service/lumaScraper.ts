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