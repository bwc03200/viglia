/**
 * VIGLA end-to-end suite (Playwright).
 *
 * Env vars:
 *  - VIGLA_URL          base URL of the running app (default http://localhost:8080)
 *  - SUPABASE_URL / VITE_SUPABASE_URL
 *  - SUPABASE_PUBLISHABLE_KEY / VITE_SUPABASE_PUBLISHABLE_KEY
 *  - SUPABASE_SERVICE_ROLE_KEY (seeding / verification only)
 */
import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestData,
  countTrips,
  getTestUserId,
  mockGeolocation,
  setOfflineMode,
  verifyAlertExists,
  verifyRLSIsolation,
  verifyTripExists,
  waitForSync,
} from "./lib/fixtures";

const VIGLA_URL = process.env["VIGLA_URL"] ?? "http://localhost:8080";

// Moulins (Allier) — dense enough to exercise hazards/radars layers.
const MOULINS_LAT = 46.5646;
const MOULINS_LNG = 3.3336;

/** Opens the app with a mocked GPS fix and waits for the map to mount. */
async function openApp(page: Page, lat = MOULINS_LAT, lng = MOULINS_LNG) {
  const restoreGeo = await mockGeolocation(page, lat, lng);
  await page.goto(VIGLA_URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".leaflet-container", { timeout: 20000 });
  return restoreGeo;
}

/**
 * Creates an alert through the UI. Kept tolerant: the report sheet is opened
 * from the floating report button, the title is typed when a text field is
 * offered, then the form is submitted.
 */
async function createAlert(page: Page, title: string) {
  await page.getByRole("button", { name: /signaler|report/i }).first().click();
  const field = page.getByRole("textbox").first();
  if (await field.isVisible().catch(() => false)) {
    await field.fill(title);
  }
  await page
    .getByRole("button", { name: /valider|envoyer|save|confirm/i })
    .first()
    .click();
}

/** Deletes the alert currently listed in the UI. */
async function deleteAlert(page: Page, title: string) {
  const row = page.getByText(title, { exact: false }).first();
  if (await row.isVisible().catch(() => false)) {
    await row.click();
  }
  await page
    .getByRole("button", { name: /supprimer|delete/i })
    .first()
    .click();
}

test.describe("VIGLA — persistence, realtime and RLS", () => {
  let userId = "";

  test.beforeEach(() => {
    userId = getTestUserId();
  });

  test.afterEach(async () => {
    await cleanupTestData(userId);
  });

  test("should save speed zone alert to Supabase", async ({ page }) => {
    const restoreGeo = await openApp(page);
    await createAlert(page, "Speed Zone 90");

    const saved = await waitForSync(
      () => verifyAlertExists(userId, "Speed Zone 90"),
      5000,
    );
    expect(saved).toBe(true);
    await restoreGeo();
  });

  test("should load alerts after page reload", async ({ page }) => {
    const restoreGeo = await openApp(page);
    await createAlert(page, "Persist Alert");
    await waitForSync(() => verifyAlertExists(userId, "Persist Alert"), 5000);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".leaflet-container", { timeout: 20000 });

    const stillThere = await verifyAlertExists(userId, "Persist Alert");
    expect(stillThere).toBe(true);
    await restoreGeo();
  });

  test("should sync alerts across browser tabs (Realtime)", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const tab1 = await context.newPage();
    const tab2 = await context.newPage();

    const restore1 = await openApp(tab1);
    await openApp(tab2);

    await createAlert(tab1, "Tab Sync");

    const synced = await waitForSync(
      () => verifyAlertExists(userId, "Tab Sync"),
      5000,
    );
    expect(synced).toBe(true);

    await restore1();
    await context.close();
  });

  test("should delete alert from Supabase", async ({ page }) => {
    const restoreGeo = await openApp(page);
    await createAlert(page, "Delete Me");
    await waitForSync(() => verifyAlertExists(userId, "Delete Me"), 5000);

    await deleteAlert(page, "Delete Me");
    await page.waitForTimeout(1000);

    const stillExists = await verifyAlertExists(userId, "Delete Me");
    expect(stillExists).toBe(false);
    await restoreGeo();
  });

  test("should handle offline alerts and sync when back online", async ({
    page,
  }) => {
    const restoreGeo = await openApp(page);

    setOfflineMode(page, true);
    await createAlert(page, "Offline Alert");
    await page.waitForTimeout(500);
    setOfflineMode(page, false);

    const synced = await waitForSync(
      () => verifyAlertExists(userId, "Offline Alert"),
      5000,
    );
    expect(synced).toBe(true);
    await restoreGeo();
  });

  test("should enforce Row Level Security", async ({ browser }) => {
    const user1Id = userId;
    const user2Id = getTestUserId();

    const context1 = await browser.newContext();
    const page1 = await context1.newPage();
    const restore1 = await openApp(page1);
    await createAlert(page1, "Private");
    await waitForSync(() => verifyAlertExists(user1Id, "Private"), 5000);

    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    await openApp(page2);
    await expect(page2.getByText("Private", { exact: false })).toHaveCount(0);

    const isolated = await verifyRLSIsolation(user1Id, user2Id);
    expect(isolated).toBe(true);

    await restore1();
    await cleanupTestData(user2Id);
    await context1.close();
    await context2.close();
  });

  test("should save alert with acceptable latency", async ({ page }) => {
    const restoreGeo = await openApp(page);

    const start = Date.now();
    await createAlert(page, "Latency Check");
    await waitForSync(() => verifyAlertExists(userId, "Latency Check"), 5000);
    const latency = Date.now() - start;

    expect(latency).toBeLessThan(3000);
    await restoreGeo();
  });

  test("should save trip history after navigation", async ({ page }) => {
    const restoreGeo = await openApp(page);

    // Drive a short synthetic leg so the trip tracker crosses its 100 m floor.
    const context = page.context();
    for (let i = 1; i <= 10; i += 1) {
      await context.setGeolocation({
        latitude: MOULINS_LAT + i * 0.0009,
        longitude: MOULINS_LNG + i * 0.0009,
      });
      await page.waitForTimeout(400);
    }

    await waitForSync(async () => (await countTrips(userId)) > 0, 8000);
    const trips = await countTrips(userId);
    expect(trips).toBeGreaterThan(0);
    expect(await verifyTripExists(userId, "")).toBe(true);

    await restoreGeo();
  });
});
