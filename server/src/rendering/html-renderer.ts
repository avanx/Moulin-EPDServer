import { BrowserPool } from "./browser-pool.js";
import type { HtmlRenderOptions } from "./types.js";

export class HtmlRenderer {
  readonly #pool: BrowserPool;
  readonly #ownsPool: boolean;

  constructor(pool?: BrowserPool) {
    this.#pool = pool ?? new BrowserPool();
    this.#ownsPool = pool === undefined;
  }

  async renderPng(options: HtmlRenderOptions): Promise<Buffer> {
    if (
      !Number.isInteger(options.width) ||
      options.width <= 0 ||
      !Number.isInteger(options.height) ||
      options.height <= 0
    ) {
      throw new RangeError("Render dimensions must be positive integers");
    }
    const lease = await this.#pool.acquire();
    try {
      const context = await lease.browser.newContext({
        viewport: { width: options.width, height: options.height },
        deviceScaleFactor: options.deviceScaleFactor ?? 1,
        colorScheme: "light",
        reducedMotion: "reduce",
      });
      try {
        await context.route("**/*", async (route) => {
          const url = route.request().url();
          if (url.startsWith("http://") || url.startsWith("https://")) {
            await route.abort("blockedbyclient");
          } else {
            await route.continue();
          }
        });
        const page = await context.newPage();
        const timeout = options.timeoutMs ?? 30_000;
        page.setDefaultTimeout(timeout);
        page.setDefaultNavigationTimeout(timeout);
        await page.setContent(options.html, { waitUntil: "networkidle", timeout });
        if (options.waitForFonts ?? true) {
          await page.evaluate("document.fonts.ready");
        }
        await page.waitForFunction(
          "window.__EPD_RENDER_READY__ === true",
          undefined,
          { timeout },
        );
        return await page.screenshot({
          type: "png",
          fullPage: false,
          omitBackground: false,
        });
      } finally {
        await context.close();
      }
    } finally {
      lease.release();
    }
  }

  async close(): Promise<void> {
    if (this.#ownsPool) {
      await this.#pool.close();
    }
  }
}

export async function renderHtmlToPng(
  options: HtmlRenderOptions,
  pool?: BrowserPool,
): Promise<Buffer> {
  const renderer = new HtmlRenderer(pool);
  try {
    return await renderer.renderPng(options);
  } finally {
    await renderer.close();
  }
}
