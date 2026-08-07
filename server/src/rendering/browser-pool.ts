import {
  chromium,
  type Browser,
  type LaunchOptions,
} from "playwright";

export interface BrowserPoolOptions {
  readonly maxBrowsers?: number;
  readonly launchOptions?: LaunchOptions;
}

export interface BrowserLease {
  readonly browser: Browser;
  release(): void;
}

interface Waiter {
  readonly resolve: (browser: Browser) => void;
  readonly reject: (error: Error) => void;
}

export class BrowserPool {
  readonly #maxBrowsers: number;
  readonly #launchOptions: LaunchOptions;
  readonly #idle: Browser[] = [];
  readonly #browsers = new Set<Browser>();
  readonly #waiters: Waiter[] = [];
  #launches = 0;
  #closed = false;

  constructor(options: BrowserPoolOptions = {}) {
    this.#maxBrowsers = options.maxBrowsers ?? 1;
    if (!Number.isInteger(this.#maxBrowsers) || this.#maxBrowsers <= 0) {
      throw new RangeError("maxBrowsers must be a positive integer");
    }
    this.#launchOptions = options.launchOptions ?? {};
  }

  async acquire(): Promise<BrowserLease> {
    if (this.#closed) {
      throw new Error("Browser pool is closed");
    }

    let browser = this.#idle.pop();
    if (browser === undefined) {
      if (this.#browsers.size + this.#launches < this.#maxBrowsers) {
        this.#launches += 1;
        try {
          browser = await chromium.launch(this.#launchOptions);
          if (this.#closed) {
            await browser.close();
            throw new Error("Browser pool was closed during launch");
          }
          this.#browsers.add(browser);
        } catch (error) {
          const failure =
            error instanceof Error ? error : new Error(String(error));
          for (const waiter of this.#waiters.splice(0)) {
            waiter.reject(failure);
          }
          throw failure;
        } finally {
          this.#launches -= 1;
        }
      } else {
        browser = await new Promise<Browser>((resolve, reject) => {
          this.#waiters.push({ resolve, reject });
        });
      }
    }

    let released = false;
    return {
      browser,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.#release(browser);
      },
    };
  }

  #release(browser: Browser): void {
    if (this.#closed || !browser.isConnected()) {
      this.#browsers.delete(browser);
      void browser.close().catch(() => undefined);
      return;
    }
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve(browser);
    } else {
      this.#idle.push(browser);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    const error = new Error("Browser pool is closed");
    for (const waiter of this.#waiters.splice(0)) {
      waiter.reject(error);
    }
    const browsers = [...this.#browsers];
    this.#idle.length = 0;
    this.#browsers.clear();
    await Promise.all(browsers.map((browser) => browser.close()));
  }
}
