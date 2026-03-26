import { scrapeCalendarAPI } from './service/lumaScraper';
import { getKnownEvents, saveKnownEvents } from './service/storage';
import { ApifyLumaEvent } from './type';
// import { sendWhatsAppAlert } from './services/whatsapp'; // Import this when you add the WhatsApp logic

export async function checkForNewEvents() {

    const TARGET_CALENDARS = process.env.TARGET_CALENDARS!.split(',');
    
    let allLiveEvents: ApifyLumaEvent[] = [];

    for (const calId of TARGET_CALENDARS) {
        const events = await scrapeCalendarAPI(calId);
        allLiveEvents.push(...events);
        await new Promise(res => setTimeout(res, 1000)); // Polite delay between targets
    }
    
    if (allLiveEvents.length === 0) return;

    const knownEvents = await getKnownEvents();
    const knownIds = knownEvents.map(evt => evt.id);
    const newEvents = allLiveEvents.filter(evt => !knownIds.includes(evt.id));

    if (newEvents.length > 0) {
        console.log(`\nFOUND ${newEvents.length} NEW EVENTS!`);
        console.log(JSON.stringify(newEvents, null, 2));

        // When ready, loop over newEvents and call your sendWhatsAppAlert(evt) here

        const updatedEvents = [...knownEvents, ...newEvents];
        await saveKnownEvents(updatedEvents);
        console.log(`\nstate.json updated with new records.`);
    } else {
        console.log(`\n✅ No new events found today.`);
    }
}