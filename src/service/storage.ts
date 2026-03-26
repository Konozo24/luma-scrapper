import fs from 'fs/promises';
import path from 'path';
import { ApifyLumaEvent } from '../type';

const STATE_FILE = path.resolve('./state.json');

export async function getKnownEvents(): Promise<ApifyLumaEvent[]> {
    try {
        const data = await fs.readFile(STATE_FILE, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        return [];
    }
}

export async function saveKnownEvents(events: ApifyLumaEvent[]) {
    await fs.writeFile(STATE_FILE, JSON.stringify(events, null, 2));
}