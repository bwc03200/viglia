import { createClient } from '@supabase/supabase-js';
import { Page, BrowserContext } from '@playwright/test';

const SUPABASE_URL = process.env['SUPABASE_URL'] ?? 'http://localhost:54321';
const SUPABASE_ANON_KEY = process.env['SUPABASE_ANON_KEY'] ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBsYXRmb3JtIiwicm9sZSI6ImFub24iLCJpYXQiOjE2MjAwMDAwMDAsImV4cCI6MTc4Nzg4MDAwMH0.abc123';
const SUPABASE_SERVICE_KEY = process.env['SUPABASE_SERVICE_KEY'] ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBsYXRmb3JtIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTYyMDAwMDAwMCwiZXhwIjoxNzg3ODgwMDAwfQ.abc123';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
export const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

export async function getTestUserId(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  return data.session?.user.id || 'test-user-id';
}

export async function cleanupTestData(userId: string) {
  await supabaseAdmin.from('alerts').delete().eq('user_id', userId);
  await supabaseAdmin.from('trips').delete().eq('user_id', userId);
}

export async function verifyAlertExists(userId: string, lat: number, lng: number, type: string) {
  const { data } = await supabase
    .from('alerts')
    .select('*')
    .eq('user_id', userId)
    .eq('latitude', lat)
    .eq('longitude', lng)
    .eq('type', type)
    .single();
  return !!data;
}

export async function verifyTripExists(userId: string, destination: string, distance: number) {
  const { data } = await supabase
    .from('trips')
    .select('*')
    .eq('user_id', userId)
    .eq('destination', destination)
    .gte('distance', distance - 1)
    .lte('distance', distance + 1)
    .single();
  return !!data;
}

export async function countAlerts(userId: string): Promise<number> {
  const { count } = await supabase
    .from('alerts')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId);
  return count || 0;
}

export async function countTrips(userId: string): Promise<number> {
  const { count } = await supabase
    .from('trips')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId);
  return count || 0;
}

export async function verifyRLSIsolation(user1Id: string, user2Id: string) {
  const user1Alerts = await countAlerts(user1Id);
  const user2Alerts = await countAlerts(user2Id);
  return user1Alerts > 0 && user2Alerts === 0;
}

export async function waitForSync(ms: number = 1000) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function mockGeolocation(page: Page, lat: number, lng: number) {
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation({ latitude: lat, longitude: lng });
}

export async function setOfflineMode(context: BrowserContext, offline: boolean) {
  await context.setOffline(offline);
}

export async function takeScreenshot(page: Page, filename: string) {
  await page.screenshot({ path: `tests/screenshots/${filename}.png` });
}

export function logTestEvent(event: string) {
  console.log(`[TEST] ${event}`);
}

export function logTestError(error: string) {
  console.error(`[TEST ERROR] ${error}`);
}

export function logTestSuccess(message: string) {
  console.log(`[TEST SUCCESS] ${message}`);
}

export async function validateSupabaseConfig() {
  try {
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    logTestSuccess('Supabase configured correctly');
  } catch (err) {
    logTestError(`Supabase configuration error: ${err}`);
  }
}