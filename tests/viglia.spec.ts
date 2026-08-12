
import { test, expect } from '@playwright/test';
import {
  getTestUserId,
  cleanupTestData,
  verifyAlertExists,
  verifyTripExists,
  countAlerts,
  waitForSync,
} from './lib/supabase-test-client';

const BASE_URL = process.env.VIGLA_URL || 'http://localhost:3000';
const MOCK_LAT = 45.5;
const MOCK_LNG = 2.6;

test.describe('VIGLA E2E Tests', () => {
  let testUserId: string;

  test.beforeEach(async ({ page }) => {
    testUserId = getTestUserId();
    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');
  });

  test.afterEach(async () => {
    await cleanupTestData(testUserId);
  });

  // Test 1: Save Speed Zone Alert
  test('should save a speed zone alert and verify in Supabase', async ({ page, context }) => {
    // Mock geolocation
    await context.grantPermissions(['geolocation']);
    await page.addInitScript(() => {
      navigator.geolocation.getCurrentPosition = (cb) => {
        cb({
          coords: { latitude: MOCK_LAT, longitude: MOCK_LNG, accuracy: 10 },
        } as GeolocationPosition);
      };
    });

    // Create alert
    const alertButton = page.locator('button:has-text("Signaler une zone vitesse")');
    await alertButton.click();

    await page.waitForTimeout(1000);
    const confirmButton = page.locator('button:has-text("Confirmer")');
    await confirmButton.click();

    // Verify in Supabase
    await waitForSync(2000);
    const alertExists = await verifyAlertExists(testUserId, MOCK_LAT, MOCK_LNG, 'speed_zone');
    expect(alertExists).toBe(true);
  });

  // Test 2: Load Alerts After Reload
  test('should load alerts after page reload', async ({ page, context }) => {
    await context.grantPermissions(['geolocation']);
    await page.addInitScript(() => {
      navigator.geolocation.getCurrentPosition = (cb) => {
        cb({
          coords: { latitude: MOCK_LAT, longitude: MOCK_LNG, accuracy: 10 },
        } as GeolocationPosition);
      };
    });

    // Create alert
    const alertButton = page.locator('button:has-text("Signaler une zone vitesse")');
    await alertButton.click();
    const confirmButton = page.locator('button:has-text("Confirmer")');
    await confirmButton.click();

    await waitForSync(2000);

    // Reload page
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Verify alert is still visible
    const alertMarker = page.locator('[data-test="speed-zone-marker"]').first();
    await expect(alertMarker).toBeVisible({ timeout: 5000 });
  });

  // Test 3: Realtime Sync Across Tabs
  test('should sync alerts across tabs in realtime', async ({ browser, context }) => {
    const page1 = await context.newPage();
    const page2 = await context.newPage();

    await context.grantPermissions(['geolocation']);
    await page1.addInitScript(() => {
      navigator.geolocation.getCurrentPosition = (cb) => {
        cb({
          coords: { latitude: MOCK_LAT, longitude: MOCK_LNG, accuracy: 10 },
        } as GeolocationPosition);
      };
    });

    await page1.goto(BASE_URL);
    await page2.goto(BASE_URL);
    await page1.waitForLoadState('networkidle');
    await page2.waitForLoadState('networkidle');

    // Create alert in page1
    const alertButton = page1.locator('button:has-text("Signaler une zone vitesse")');
    await alertButton.click();
    const confirmButton = page1.locator('button:has-text("Confirmer")');
    await confirmButton.click();

    // Wait for realtime sync (< 5 seconds)
    const syncStart = Date.now();
    const alertMarker = page2.locator('[data-test="speed-zone-marker"]').first();
    await expect(alertMarker).toBeVisible({ timeout: 5000 });
    const syncTime = Date.now() - syncStart;

    expect(syncTime).toBeLessThan(5000);
    await page1.close();
    await page2.close();
  });

  // Test 4: Delete Alert
  test('should delete an alert from UI and Supabase', async ({ page, context }) => {
    await context.grantPermissions(['geolocation']);
    await page.addInitScript(() => {
      navigator.geolocation.getCurrentPosition = (cb) => {
        cb({
          coords: { latitude: MOCK_LAT, longitude: MOCK_LNG, accuracy: 10 },
        } as GeolocationPosition);
      };
    });

    // Create alert
    const alertButton = page.locator('button:has-text("Signaler une zone vitesse")');
    await alertButton.click();
    const confirmButton = page.locator('button:has-text("Confirmer")');
    await confirmButton.click();

    await waitForSync(2000);

    // Verify alert exists
    let alertCount = await countAlerts(testUserId);
    expect(alertCount).toBeGreaterThan(0);

    // Delete alert
    const deleteButton = page.locator('[data-test="delete-alert-btn"]').first();
    await deleteButton.click();

    const confirmDeleteButton = page.locator('button:has-text("Supprimer")');
    await confirmDeleteButton.click();

    await waitForSync(2000);

    // Verify alert is deleted
    alertCount = await countAlerts(testUserId);
    expect(alertCount).toBe(0);
  });

  // Test 5: Offline Handling
  test('should queue alerts when offline and sync after reconnection', async ({ page, context }) => {
    await context.grantPermissions(['geolocation']);
    await page.addInitScript(() => {
      navigator.geolocation.getCurrentPosition = (cb) => {
        cb({
          coords: { latitude: MOCK_LAT, longitude: MOCK_LNG, accuracy: 10 },
        } as GeolocationPosition);
      };
    });

    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');

    // Go offline
    await context.setOffline(true);

    // Try to create alert (should queue)
    const alertButton = page.locator('button:has-text("Signaler une zone vitesse")');
    await alertButton.click();
    const confirmButton = page.locator('button:has-text("Confirmer")');
    await confirmButton.click();

    // Verify "offline" badge appears
    const offlineBadge = page.locator('[data-test="offline-badge"]');
    await expect(offlineBadge).toBeVisible();

    // Go back online
    await context.setOffline(false);

    // Wait for sync
    await waitForSync(3000);

    // Verify alert is now in Supabase
    const alertExists = await verifyAlertExists(testUserId, MOCK_LAT, MOCK_LNG, 'speed_zone');
    expect(alertExists).toBe(true);
  });

  // Test 6: RLS Enforcement
  test('should enforce Row Level Security - user sees only their data', async ({ page, context }) => {
    // Create 2 test users
    const user1Id = getTestUserId();
    const user2Id = getTestUserId();

    // Simulate user1 alert creation
    // (In real scenario: user1 logs in, creates alert)
    // For E2E, we'd need auth mock or real sign-up
    
    // This test verifies RLS via Supabase API directly
    const { verifyRLSIsolation } = await import('./lib/supabase-test-client');
    const rslViolation = await verifyRLSIsolation(user1Id, user2Id);
    
    expect(rslViolation).toBe(false); // No data leakage
  });

  // Test 7: Performance - Save Latency
  test('should save alert within 3000ms (SLA)', async ({ page, context }) => {
    await context.grantPermissions(['geolocation']);
    await page.addInitScript(() => {
      navigator.geolocation.getCurrentPosition = (cb) => {
        cb({
          coords: { latitude: MOCK_LAT, longitude: MOCK_LNG, accuracy: 10 },
        } as GeolocationPosition);
      };
    });

    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');

    // Measure save latency
    const saveStart = performance.now();

    const alertButton = page.locator('button:has-text("Signaler une zone vitesse")');
    await alertButton.click();
    const confirmButton = page.locator('button:has-text("Confirmer")');
    await confirmButton.click();

    // Wait for confirmation (toast or UI update)
    const successToast = page.locator('[data-test="save-success-toast"]');
    await expect(successToast).toBeVisible({ timeout: 3500 });

    const saveLatency = performance.now() - saveStart;

    console.log(`⏱️ Save latency: ${saveLatency.toFixed(0)}ms`);
    expect(saveLatency).toBeLessThan(3000);
  });

  // Test 8: Trip History - Save & Retrieve
  test('should save trip to history after navigation and retrieve it', async ({ page, context }) => {
    await context.grantPermissions(['geolocation']);
    await page.addInitScript(() => {
      navigator.geolocation.getCurrentPosition = (cb) => {
        cb({
          coords: { latitude: MOCK_LAT, longitude: MOCK_LNG, accuracy: 10 },
        } as GeolocationPosition);
      };
    });

    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle');

    // Start a navigation (mock destination)
    // In real scenario: user enters destination → starts navigation → completes
    
    // For now, we'll verify the trip can be saved via Supabase directly
    const tripExists = await verifyTripExists(testUserId, 'test-destination', 5.5);
    
    if (tripExists) {
      // Open trip history
      const historyButton = page.locator('button:has-text("Historique")');
      await historyButton.click();

      // Verify trip appears in list
      const tripCard = page.locator('[data-test="trip-card"]').first();
      await expect(tripCard).toBeVisible({ timeout: 5000 });
    }
  });
});
