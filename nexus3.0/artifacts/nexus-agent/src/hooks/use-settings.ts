import { useState, useEffect } from 'react';

export type Provider = 'groq' | 'gemini' | 'openai' | 'openrouter';
export type RunMode = 'auto' | 'agent' | 'chat';
export type BrowserMode = 'auto' | 'tinyfish' | 'playwright';

export interface Settings {
  /** Run browser tasks in your Chrome via the Nexus extension (API must not start Playwright). */
  useChromeExtension: boolean;
  provider: Provider;
  model: string;
  keys: {
    groq: string;
    gemini: string;
    openai: string;
    openrouter: string;
    tinyfish: string;
    kimi: string;
  };
  customOpenRouterModel: string;
  mode: RunMode;
  browserMode: BrowserMode;
  baseUrl: string;
}

const DEFAULT_SETTINGS: Settings = {
  /** Prefer real Chrome via extension; turn off to use server Playwright again. */
  useChromeExtension: true,
  provider: 'groq',
  model: 'llama3-70b-8192',
  keys: {
    groq: '',
    gemini: '',
    openai: '',
    openrouter: '',
    tinyfish: '',
    kimi: '',
  },
  customOpenRouterModel: '',
  mode: 'auto',
  browserMode: 'auto',
  baseUrl: '/api',
};

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(() => {
    try {
      const saved = localStorage.getItem('nexus-settings');
      if (saved) {
        const parsed = JSON.parse(saved) as Partial<Settings>;
        return {
          ...DEFAULT_SETTINGS,
          ...parsed,
          keys: { ...DEFAULT_SETTINGS.keys, ...(parsed.keys ?? {}) },
          useChromeExtension:
            typeof parsed.useChromeExtension === "boolean"
              ? parsed.useChromeExtension
              : DEFAULT_SETTINGS.useChromeExtension,
        };
      }
    } catch (e) {
      console.error('Failed to parse settings', e);
    }
    return DEFAULT_SETTINGS;
  });

  useEffect(() => {
    localStorage.setItem('nexus-settings', JSON.stringify(settings));
  }, [settings]);

  const updateSettings = (updates: Partial<Settings>) => {
    setSettings(prev => ({ ...prev, ...updates }));
  };

  const updateKey = (provider: keyof Settings['keys'], key: string) => {
    setSettings(prev => ({
      ...prev,
      keys: { ...prev.keys, [provider]: key },
    }));
  };

  const hasBrowserControl = (settings.keys.tinyfish?.length ?? 0) > 0 || true;
  const hasVision = (settings.keys.kimi?.length ?? 0) > 0;

  return { settings, updateSettings, updateKey, hasBrowserControl, hasVision };
}
