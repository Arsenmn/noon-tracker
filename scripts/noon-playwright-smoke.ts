import path from 'node:path';
import { chromium, Response } from 'playwright';

interface NoonProductResponse {
  product?: {
    sku?: string;
    variants?: Array<{
      offers?: unknown[];
    }>;
  };
}

const DEFAULT_PRODUCT_URL =
  'https://www.noon.com/uae-en/edge-60-fusion-5g-dual-sim-pantone-slipstream-12gb-ram-256gb-middle-east-version/N70164930V/p/?o=fb4993ea2234038d';

async function run(): Promise<void> {
  const productUrl = process.argv[2] ?? DEFAULT_PRODUCT_URL;
  const headless = process.env.NOON_HEADLESS !== 'false';
  const executablePath = process.env.NOON_BROWSER_EXECUTABLE;
  const disableHttp2 = process.env.NOON_DISABLE_HTTP2 === 'true';
  const profileDirectory = path.resolve(
    process.env.NOON_BROWSER_PROFILE_DIR ?? '.playwright/noon-profile',
  );

  console.log(
    `Launching Chromium (${headless ? 'headless' : 'headed'}) for ${productUrl}`,
  );

  const context = await chromium.launchPersistentContext(profileDirectory, {
    headless,
    locale: 'en-AE',
    timezoneId: 'Asia/Dubai',
    viewport: { width: 1440, height: 900 },
    ...(executablePath ? { executablePath } : {}),
    args: disableHttp2 ? ['--disable-http2'] : [],
  });

  try {
    const page = await context.newPage();
    const catalogResponses: Array<{ status: number; url: string }> = [];
    page.on('response', (response) => {
      if (response.url().includes('mp-customer-catalog-api')) {
        catalogResponses.push({
          status: response.status(),
          url: response.url(),
        });
      }
    });
    let apiResponse: Response;
    let navigationResponse: Response | null = null;

    try {
      [apiResponse, navigationResponse] = await Promise.all([
        page.waitForResponse(
          (response) => {
            const responseUrl = new URL(response.url());

            return (
              responseUrl.pathname.includes(
                '/mp-customer-catalog-api/api/v3/u/',
              ) &&
              responseUrl.pathname.endsWith('/p/') &&
              response.request().method() === 'GET'
            );
          },
          { timeout: 30_000 },
        ),
        page.goto(productUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        }),
      ]);
    } catch (error: unknown) {
      console.error(
        JSON.stringify(
          {
            pageStatus: navigationResponse?.status() ?? null,
            pageUrl: page.url(),
            pageTitle: await page.title(),
            catalogResponses,
          },
          null,
          2,
        ),
      );
      throw error;
    }

    if (!apiResponse.ok()) {
      throw new Error(`Noon API returned HTTP ${apiResponse.status()}`);
    }

    const data = (await apiResponse.json()) as NoonProductResponse;
    const variants = data.product?.variants ?? [];
    const offerCount = variants.reduce(
      (total, variant) => total + (variant.offers?.length ?? 0),
      0,
    );

    console.log(
      JSON.stringify(
        {
          pageStatus: navigationResponse?.status() ?? null,
          apiStatus: apiResponse.status(),
          apiUrl: apiResponse.url(),
          sku: data.product?.sku ?? null,
          variantCount: variants.length,
          offerCount,
        },
        null,
        2,
      ),
    );
  } finally {
    await context.close();
  }
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
