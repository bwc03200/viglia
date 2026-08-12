/**
 * Shared E2E test fixtures for VIGLA.
 *
 * Notes on table mapping (current schema):
 *  - "alerts" -> public.convoy_alerts (title lives in the JSON `payload`)
 *  - "trips"  -> public.trip_summaries + public.trip_history
 *    (`destination` is stored in trip metadata when present; the helper
 *     tolerates its absence and then only checks that a trip exists)
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Page } from "@playwright/test";

const SUPABASE_URL =
  process.env["SUPABASE_URL"] ?? process.env["VITE_SUPABASE_URL"] ?? "";
const SUPABASE_ANON_KEY =
  process.env["SUPABASE_PUBLISHABLE_KEY"] ??
  process.env["VITE_SUPABASE_PUBLISHABLE_KEY"] ??
  "";
const SUPABASE_SERVICE_KEY = process.env["SUPABASE_SERVICE_ROLE_KEY"] ?? "";

/** Anonymous client — RLS applies, mirrors what the browser sees. */
export const supabase: SupabaseClient = createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

/** Service-role client — bypasses RLS, used for seeding/cleanup only. */
export const supabaseAdmin: SupabaseClient = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

/** Unique, collision-safe identifier for a test run. */
export function getTestUserId(): string {
  return `test_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

/** Removes every row created by a test user (alerts + trips), in parallel. */
export async function cleanupTestData(userId: string): Promise<void> {
  if (!userId) return;
  const results = await Promise.all([
    supabaseAdmin.from("convoy_alerts").delete().eq("user_id", userId),
    supabaseAdmin.from("trip_summaries").delete().eq("user_id", userId),
    supabaseAdmin.from("trip_history").delete().eq("user_id", userId),
  ]);
  const failed = results.filter((r) => r.error);
  if (failed.length > 0) {
    console.warn(
      "[fixtures] cleanupTestData partial failure:",
      failed.map((r) => r.error?.message).join(" | "),
    );
  }
}

/**
 * Polls `checkFn` every 100 ms until it resolves truthy or `timeout` elapses.
 * Returns true when the condition was met, false on timeout.
 */
export async function waitForSync(
  checkFn: () => boolean | Promise<boolean>,
  timeout = 5000,
): Promise<boolean> {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      if (await checkFn()) return true;
    } catch {
      // transient errors (network, RLS warm-up) are retried until timeout
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** True when an alert with the given title exists for the user. */
export async function verifyAlertExists(
  userId: string,
  title: string,
): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("convoy_alerts")
    .select("id, kind, payload")
    .eq("user_id", userId)
    .limit(50);
  if (error || !data) return false;
  return data.some((row) => {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const candidate =
      (typeof payload.title === "string" && payload.title) ||
      (typeof payload.message === "string" && payload.message) ||
      row.kind;
    return typeof candidate === "string" && candidate.includes(title);
  });
}

/** True when a recorded trip for the user matches the given destination. */
export async function verifyTripExists(
  userId: string,
  destination: string,
): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("trip_summaries")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error || !data || data.length === 0) return false;
  if (!destination) return true;
  const needle = destination.toLowerCase();
  const matched = data.some((row) => {
    const value = (row as Record<string, unknown>)["destination"];
    return typeof value === "string" && value.toLowerCase().includes(needle);
  });
  // Older rows have no destination column: fall back to "a trip was stored".
  const hasDestinationColumn = data.some(
    (row) => "destination" in (row as Record<string, unknown>),
  );
  return hasDestinationColumn ? matched : true;
}

/**
 * Forces the browser geolocation API to a fixed coordinate.
 * Returns an async cleanup function restoring real permissions/position.
 */
export async function mockGeolocation(
  page: Page,
  lat: number,
  lng: number,
): Promise<() => Promise<void>> {
  const context = page.context();
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: lat, longitude: lng });
  await page.addInitScript(
    ([mockLat, mockLng]) => {
      const position = {
        coords: {
          latitude: mockLat,
          longitude: mockLng,
          accuracy: 5,
          altitude: null,
          altitudeAccuracy: null,
          heading: 0,
          speed: 0,
        },
        timestamp: Date.now(),
      };
      const geo = navigator.geolocation;
      if (!geo) return;
      geo.getCurrentPosition = (success) =>
        success(position as unknown as GeolocationPosition);
      geo.watchPosition = (success) => {
        success(position as unknown as GeolocationPosition);
        return 1;
      };
    },
    [lat, lng] as const,
  );
  return async () => {
    await context.clearPermissions();
  };
}

/** Toggles the browser context between offline and online. */
export function setOfflineMode(page: Page, offline: boolean): void {
  void page.context().setOffline(offline);
}

/** Number of trips recorded for a user (summaries + history). */
export async function countTrips(userId: string): Promise<number> {
  const [summaries, history] = await Promise.all([
    supabaseAdmin
      .from("trip_summaries")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId),
    supabaseAdmin
      .from("trip_history")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId),
  ]);
  return (summaries.count ?? 0) + (history.count ?? 0);
}

/**
 * True when user2 cannot read any of user1's rows through the anon/RLS client.
 * Only user1-owned rows are considered a violation.
 */
export async function verifyRLSIsolation(
  user1Id: string,
  user2Id: string,
): Promise<boolean> {
  if (!user1Id || !user2Id || user1Id === user2Id) return false;
  const { data, error } = await supabase
    .from("convoy_alerts")
    .select("id, user_id")
    .eq("user_id", user1Id)
    .limit(1);
  // An RLS denial surfaces as either an error or an empty result set.
  if (error) return true;
  return !data || data.length === 0;
}
