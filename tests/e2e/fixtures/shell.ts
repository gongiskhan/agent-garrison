import {test as base} from '@playwright/test';

export {expect} from '@playwright/test';

// Config-plane journeys use an unenrolled scratch home. The shared sidebar's
// badge is independent of those journeys; Messages tests own its real contract.
export const test = base.extend<{sidebarCounts: void}>({
  sidebarCounts: [async ({page}, use) => {
    await page.route('**/api/messages/counts', route => route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({counts: {all: 0}})
    }));
    await use();
  }, {auto: true}]
});
