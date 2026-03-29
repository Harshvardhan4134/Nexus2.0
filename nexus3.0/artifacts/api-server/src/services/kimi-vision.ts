/**
 * Kimi Vision Service (Moonshot AI)
 *
 * Uses Kimi's multimodal vision model to analyze page screenshots and
 * identify clickable/typeable elements by their pixel position (top-left x/y + dimensions)
 * rather than fragile text or CSS selectors.
 *
 * API: https://api.moonshot.cn/v1 (OpenAI-compatible)
 */

export interface ElementTarget {
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  confidence: number;
  description: string;
}

export interface KimiVisionConfig {
  apiKey: string;
  model?: string;
}

const KIMI_BASE_URL = "https://api.moonshot.cn/v1";
const DEFAULT_VISION_MODEL = "moonshot-v1-vision-preview";

/**
 * Ask Kimi to locate a UI element in a screenshot.
 * Returns pixel coordinates (top-left x/y, width/height) for use with Playwright.
 */
export async function findElementByVision(
  screenshotBase64: string,
  intent: string,
  pageWidth: number,
  pageHeight: number,
  config: KimiVisionConfig
): Promise<ElementTarget | null> {
  const model = config.model || DEFAULT_VISION_MODEL;

  const systemPrompt = `You are a precise UI element locator. When given a screenshot and a description of what to interact with, you must identify the exact pixel location of that element.

RULES:
- Return ONLY a JSON object, no other text.
- Coordinates must be in pixels from the TOP-LEFT corner of the image.
- The image dimensions are ${pageWidth}x${pageHeight} pixels.
- Be precise — the coordinates will be used directly for mouse clicks.
- If multiple matching elements exist, return the most prominent/relevant one.
- If element is not found, return null.

Response format (JSON only):
{
  "found": true,
  "x": <left edge in pixels>,
  "y": <top edge in pixels>,  
  "width": <element width in pixels>,
  "height": <element height in pixels>,
  "confidence": <0.0 to 1.0>,
  "description": "<brief description of what you found>"
}

Or if not found:
{ "found": false, "description": "<why not found>" }`;

  const userPrompt = `Locate this element in the screenshot: "${intent}"

Return the bounding box (x, y, width, height) from the top-left of the image.`;

  const payload = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: {
              url: `data:image/jpeg;base64,${screenshotBase64}`,
            },
          },
          { type: "text", text: userPrompt },
        ],
      },
    ],
    temperature: 0.1,
    max_tokens: 256,
  };

  const response = await fetch(`${KIMI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Kimi vision API error ${response.status}: ${text}`);
  }

  const data = (await response.json()) as {
    choices: { message: { content: string } }[];
  };

  const content = data.choices?.[0]?.message?.content?.trim() ?? "";

  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  const parsed = JSON.parse(jsonMatch[0]) as {
    found: boolean;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    confidence?: number;
    description?: string;
  };

  if (!parsed.found || parsed.x === undefined) return null;

  const x = parsed.x;
  const y = parsed.y ?? 0;
  const width = parsed.width ?? 20;
  const height = parsed.height ?? 20;

  return {
    x,
    y,
    width,
    height,
    centerX: Math.round(x + width / 2),
    centerY: Math.round(y + height / 2),
    confidence: parsed.confidence ?? 0.8,
    description: parsed.description ?? intent,
  };
}

/**
 * Ask Kimi to describe the page structure to help the LLM understand context.
 */
export async function describePageContent(
  screenshotBase64: string,
  taskContext: string,
  config: KimiVisionConfig
): Promise<string> {
  const model = config.model || DEFAULT_VISION_MODEL;

  const payload = {
    model,
    messages: [
      {
        role: "system",
        content:
          "You are a page analyzer. Describe the visible UI elements, their positions, and what actions are available. Be concise and structured. Focus on interactive elements (buttons, inputs, links, dropdowns). Describe positions as top/bottom/left/right/center of the page.",
      },
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${screenshotBase64}` },
          },
          {
            type: "text",
            text: `Analyze this page screenshot for the following task context: "${taskContext}"\n\nDescribe the visible UI elements, their approximate positions, and what interactive elements are present.`,
          },
        ],
      },
    ],
    temperature: 0.2,
    max_tokens: 512,
  };

  const response = await fetch(`${KIMI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Kimi vision API error ${response.status}`);
  }

  const data = (await response.json()) as {
    choices: { message: { content: string } }[];
  };
  return data.choices?.[0]?.message?.content ?? "";
}
