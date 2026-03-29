/**
 * Browser Controller — Orchestrates TinyFish → Kimi Vision → Playwright
 *
 * Strategy:
 * 1. PRIMARY: TinyFish DOM-based control (navigate, CSS selectors, extract)
 * 2. VISION FALLBACK: When DOM is sparse or selector fails, capture screenshot
 *    and ask Kimi to identify target element by position (top-left x/y + dims)
 * 3. PLAYWRIGHT FALLBACK: Execute clicks/types at Kimi-provided coordinates
 *    using Playwright's coordinate-based mouse actions
 */

import { chromium, Browser, Page } from "playwright";
import * as tf from "./tinyfish.js";
import { findElementByVision, describePageContent, KimiVisionConfig } from "./kimi-vision.js";
import { logger } from "../lib/logger.js";

export interface BrowserControllerConfig {
  tinyfishKey?: string;
  kimiKey?: string;
  browserMode?: "tinyfish" | "playwright" | "auto";
}

export interface BrowserAction {
  type: "navigate" | "click" | "type" | "screenshot" | "extract" | "scroll" | "wait";
  url?: string;
  selector?: string;
  text?: string;
  intent?: string;
  timeout?: number;
}

export interface BrowserActionResult {
  success: boolean;
  error?: string;
  url?: string;
  title?: string;
  html?: string;
  textContent?: string;
  screenshotBase64?: string;
  isSparseDom?: boolean;
  usedVision?: boolean;
  elementTarget?: { x: number; y: number; width: number; height: number; centerX: number; centerY: number };
  executionMode?: "tinyfish" | "playwright-vision" | "playwright-dom";
}

interface ControllerState {
  tinyfishSessionId?: string;
  playwrightBrowser?: Browser;
  playwrightPage?: Page;
  lastScreenshot?: string;
  currentUrl?: string;
}

export class BrowserController {
  private config: BrowserControllerConfig;
  private state: ControllerState = {};
  private tfConfig?: tf.TinyFishConfig;
  private kimiConfig?: KimiVisionConfig;

  constructor(config: BrowserControllerConfig) {
    this.config = config;
    if (config.tinyfishKey) {
      this.tfConfig = { apiKey: config.tinyfishKey };
    }
    if (config.kimiKey) {
      this.kimiConfig = { apiKey: config.kimiKey };
    }
  }

  private get useTinyFish(): boolean {
    return (
      !!this.tfConfig &&
      (this.config.browserMode === "tinyfish" || this.config.browserMode === "auto" || !this.config.browserMode)
    );
  }

  private get usePlaywright(): boolean {
    return this.config.browserMode === "playwright" || !this.tfConfig;
  }

  async execute(action: BrowserAction): Promise<BrowserActionResult> {
    if (this.useTinyFish) {
      return this.executeTinyFish(action);
    }
    return this.executePlaywright(action);
  }

  // ── TinyFish path ────────────────────────────────────────────────────────

  private async ensureTinyFishSession(): Promise<void> {
    if (this.state.tinyfishSessionId) return;
    const session = await tf.createSession(this.tfConfig!);
    this.state.tinyfishSessionId = session.sessionId;
    logger.info({ sessionId: session.sessionId }, "TinyFish browser session created");
  }

  private async executeTinyFish(action: BrowserAction): Promise<BrowserActionResult> {
    try {
      await this.ensureTinyFishSession();
      const sid = this.state.tinyfishSessionId!;

      if (action.type === "navigate" && action.url) {
        const pageState = await tf.navigate(sid, action.url, this.tfConfig!);
        this.state.currentUrl = pageState.url;
        this.state.lastScreenshot = pageState.screenshot;

        if (pageState.isSparseDom && this.kimiConfig && pageState.screenshot) {
          logger.info("DOM sparse — using Kimi vision to describe page");
          const description = await describePageContent(
            pageState.screenshot,
            action.url,
            this.kimiConfig
          );
          return {
            success: true,
            url: pageState.url,
            title: pageState.title,
            html: pageState.html,
            textContent: description,
            screenshotBase64: pageState.screenshot,
            isSparseDom: true,
            usedVision: true,
            executionMode: "tinyfish",
          };
        }

        return {
          success: true,
          url: pageState.url,
          title: pageState.title,
          html: pageState.html,
          textContent: pageState.text,
          screenshotBase64: pageState.screenshot,
          isSparseDom: pageState.isSparseDom,
          executionMode: "tinyfish",
        };
      }

      if (action.type === "click") {
        if (action.selector) {
          const result = await tf.clickElement(sid, action.selector, this.tfConfig!);
          if (result.success) return { success: true, executionMode: "tinyfish" };

          logger.warn({ selector: action.selector, error: result.error }, "TinyFish DOM click failed — trying vision");
        }

        // Vision fallback: ask Kimi where to click
        if (this.kimiConfig && action.intent) {
          return this.visionClickTinyFish(sid, action.intent);
        }

        return { success: false, error: "Click failed: no selector match and no vision config" };
      }

      if (action.type === "type") {
        if (action.selector && action.text) {
          const result = await tf.typeText(sid, action.selector, action.text, this.tfConfig!);
          if (result.success) return { success: true, executionMode: "tinyfish" };

          logger.warn({ selector: action.selector }, "TinyFish DOM type failed — trying vision");
        }

        if (this.kimiConfig && action.intent && action.text) {
          return this.visionTypeTinyFish(sid, action.intent, action.text);
        }

        return { success: false, error: "Type failed: no selector match and no vision config" };
      }

      if (action.type === "screenshot") {
        const screenshot = await tf.captureScreenshot(sid, this.tfConfig!);
        this.state.lastScreenshot = screenshot ?? undefined;
        return { success: !!screenshot, screenshotBase64: screenshot ?? undefined, executionMode: "tinyfish" };
      }

      if (action.type === "extract") {
        const pageState = await tf.getPageState(sid, this.tfConfig!);
        return {
          success: true,
          url: pageState.url,
          html: pageState.html,
          textContent: pageState.text,
          screenshotBase64: pageState.screenshot,
          isSparseDom: pageState.isSparseDom,
          executionMode: "tinyfish",
        };
      }

      return { success: false, error: `Unknown action type: ${action.type}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err }, "TinyFish action error — falling back to Playwright");

      if (this.config.browserMode !== "tinyfish") {
        return this.executePlaywright(action);
      }
      return { success: false, error: msg };
    }
  }

  private async visionClickTinyFish(tinyfishSessionId: string, intent: string): Promise<BrowserActionResult> {
    const screenshot = await tf.captureScreenshot(tinyfishSessionId, this.tfConfig!);
    if (!screenshot) return { success: false, error: "Could not capture screenshot for vision" };

    this.state.lastScreenshot = screenshot;

    const target = await findElementByVision(screenshot, intent, 1280, 720, this.kimiConfig!);
    if (!target) return { success: false, error: `Kimi could not find element: "${intent}"` };

    logger.info({ target, intent }, "Kimi vision identified click target");

    const result = await tf.clickAtCoordinates(tinyfishSessionId, target.centerX, target.centerY, this.tfConfig!);
    return {
      success: result.success,
      error: result.error,
      usedVision: true,
      elementTarget: target,
      executionMode: "tinyfish",
    };
  }

  private async visionTypeTinyFish(tinyfishSessionId: string, intent: string, text: string): Promise<BrowserActionResult> {
    const screenshot = await tf.captureScreenshot(tinyfishSessionId, this.tfConfig!);
    if (!screenshot) return { success: false, error: "Could not capture screenshot for vision" };

    this.state.lastScreenshot = screenshot;

    const target = await findElementByVision(screenshot, intent, 1280, 720, this.kimiConfig!);
    if (!target) return { success: false, error: `Kimi could not find input field: "${intent}"` };

    logger.info({ target, intent }, "Kimi vision identified type target");

    const result = await tf.typeAtCoordinates(tinyfishSessionId, target.centerX, target.centerY, text, this.tfConfig!);
    return {
      success: result.success,
      error: result.error,
      usedVision: true,
      elementTarget: target,
      executionMode: "tinyfish",
    };
  }

  // ── Playwright path ───────────────────────────────────────────────────────

  private async ensurePlaywright(): Promise<Page> {
    if (!this.state.playwrightBrowser) {
      this.state.playwrightBrowser = await chromium.launch({ headless: true });
    }
    if (!this.state.playwrightPage) {
      const ctx = await this.state.playwrightBrowser.newContext({
        viewport: { width: 1280, height: 720 },
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      });
      this.state.playwrightPage = await ctx.newPage();
    }
    return this.state.playwrightPage;
  }

  private async executePlaywright(action: BrowserAction): Promise<BrowserActionResult> {
    try {
      const page = await this.ensurePlaywright();

      if (action.type === "navigate" && action.url) {
        await page.goto(action.url, { waitUntil: "networkidle", timeout: 30000 });
        const html = await page.content();
        const title = await page.title();
        const url = page.url();
        const isSparseDomResult = tf.isSparseDom(html);
        this.state.currentUrl = url;

        let textContent: string | undefined;
        let screenshot: string | undefined;

        if (isSparseDomResult && this.kimiConfig) {
          const screenshotBuffer = await page.screenshot({ type: "jpeg", quality: 70 });
          screenshot = screenshotBuffer.toString("base64");
          this.state.lastScreenshot = screenshot;

          textContent = await describePageContent(screenshot, action.url, this.kimiConfig);
        } else {
          textContent = await page.evaluate(() => document.body.innerText);
        }

        return {
          success: true,
          url,
          title,
          html,
          textContent,
          screenshotBase64: screenshot,
          isSparseDom: isSparseDomResult,
          usedVision: isSparseDomResult && !!this.kimiConfig,
          executionMode: "playwright-dom",
        };
      }

      if (action.type === "click") {
        if (action.selector) {
          try {
            await page.click(action.selector, { timeout: 5000 });
            return { success: true, executionMode: "playwright-dom" };
          } catch {
            logger.warn({ selector: action.selector }, "Playwright DOM click failed — trying vision");
          }
        }

        if (this.kimiConfig && action.intent) {
          return this.visionClickPlaywright(page, action.intent);
        }
        return { success: false, error: "Click failed: no selector and no vision config" };
      }

      if (action.type === "type") {
        if (action.selector && action.text) {
          try {
            await page.fill(action.selector, action.text, { timeout: 5000 });
            return { success: true, executionMode: "playwright-dom" };
          } catch {
            logger.warn({ selector: action.selector }, "Playwright DOM type failed — trying vision");
          }
        }

        if (this.kimiConfig && action.intent && action.text) {
          return this.visionTypePlaywright(page, action.intent, action.text);
        }
        return { success: false, error: "Type failed: no selector and no vision config" };
      }

      if (action.type === "screenshot") {
        const buf = await page.screenshot({ type: "jpeg", quality: 80 });
        const b64 = buf.toString("base64");
        this.state.lastScreenshot = b64;
        return { success: true, screenshotBase64: b64, executionMode: "playwright-dom" };
      }

      if (action.type === "extract") {
        const html = await page.content();
        const textContent = await page.evaluate(() => document.body.innerText);
        const url = page.url();
        return {
          success: true,
          url,
          html,
          textContent,
          isSparseDom: tf.isSparseDom(html),
          executionMode: "playwright-dom",
        };
      }

      if (action.type === "scroll") {
        await page.evaluate(() => window.scrollBy(0, 400));
        return { success: true, executionMode: "playwright-dom" };
      }

      if (action.type === "wait") {
        await page.waitForTimeout(action.timeout ?? 2000);
        return { success: true, executionMode: "playwright-dom" };
      }

      return { success: false, error: `Unknown action type: ${action.type}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  }

  private async visionClickPlaywright(page: Page, intent: string): Promise<BrowserActionResult> {
    const buf = await page.screenshot({ type: "jpeg", quality: 70 });
    const screenshot = buf.toString("base64");
    this.state.lastScreenshot = screenshot;

    const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
    const target = await findElementByVision(screenshot, intent, viewport.width, viewport.height, this.kimiConfig!);

    if (!target) return { success: false, error: `Kimi could not locate element: "${intent}"` };

    logger.info({ target, intent }, "Kimi vision → Playwright click at coordinates");

    await page.mouse.click(target.centerX, target.centerY);
    return {
      success: true,
      usedVision: true,
      elementTarget: target,
      executionMode: "playwright-vision",
    };
  }

  private async visionTypePlaywright(page: Page, intent: string, text: string): Promise<BrowserActionResult> {
    const buf = await page.screenshot({ type: "jpeg", quality: 70 });
    const screenshot = buf.toString("base64");
    this.state.lastScreenshot = screenshot;

    const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
    const target = await findElementByVision(screenshot, intent, viewport.width, viewport.height, this.kimiConfig!);

    if (!target) return { success: false, error: `Kimi could not locate input: "${intent}"` };

    logger.info({ target, intent }, "Kimi vision → Playwright type at coordinates");

    await page.mouse.click(target.centerX, target.centerY);
    await page.keyboard.type(text, { delay: 30 });

    return {
      success: true,
      usedVision: true,
      elementTarget: target,
      executionMode: "playwright-vision",
    };
  }

  async getLastScreenshot(): Promise<string | undefined> {
    return this.state.lastScreenshot;
  }

  async getCurrentUrl(): Promise<string | undefined> {
    return this.state.currentUrl;
  }

  async close(): Promise<void> {
    if (this.state.tinyfishSessionId && this.tfConfig) {
      await tf.closeSession(this.state.tinyfishSessionId, this.tfConfig).catch(() => {});
    }
    if (this.state.playwrightPage) {
      await this.state.playwrightPage.close().catch(() => {});
    }
    if (this.state.playwrightBrowser) {
      await this.state.playwrightBrowser.close().catch(() => {});
    }
  }
}
