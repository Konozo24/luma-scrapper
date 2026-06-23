import { ApifyLumaEvent } from '../type';

const TARGET_COUNTRIES = ['Malaysia', 'Singapore'];

export function isEventFromTargetCountry(event: ApifyLumaEvent): boolean {
  const country = event.location?.country;
  
  // Virtual events (no country) are excluded
  if (!country) return false;
  
  return TARGET_COUNTRIES.includes(country);
}
