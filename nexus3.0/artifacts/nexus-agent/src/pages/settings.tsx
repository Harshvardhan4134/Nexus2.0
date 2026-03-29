import React from 'react';
import { motion } from 'framer-motion';
import { Key, Cpu, Zap, Settings2, Globe, Eye, MousePointer } from 'lucide-react';
import { useSettings, Provider, RunMode, BrowserMode } from '@/hooks/use-settings';
import { Input, Button, Badge } from '@/components/ui-elements';

export default function SettingsView() {
  const { settings, updateSettings, updateKey } = useSettings();
  const [saved, setSaved] = React.useState(false);

  const handleSave = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const llmProviders: { id: Provider; name: string; defaultModel: string }[] = [
    { id: 'groq', name: 'Groq', defaultModel: 'llama3-70b-8192' },
    { id: 'gemini', name: 'Google Gemini', defaultModel: 'gemini-1.5-pro' },
    { id: 'openai', name: 'OpenAI', defaultModel: 'gpt-4o' },
    { id: 'openrouter', name: 'OpenRouter', defaultModel: 'anthropic/claude-3-opus' },
  ];

  const modes: { id: RunMode; name: string; desc: string }[] = [
    { id: 'auto', name: 'Auto', desc: 'Agent decides — browser for tasks, chat for questions.' },
    { id: 'agent', name: 'Agent Only', desc: 'Always uses browser automation.' },
    { id: 'chat', name: 'Chat Only', desc: 'Plain LLM response, no browser.' },
  ];

  const browserModes: { id: BrowserMode; name: string; desc: string; badge?: string }[] = [
    { id: 'auto', name: 'Auto', desc: 'TinyFish first, Playwright if unavailable.', badge: 'Recommended' },
    { id: 'tinyfish', name: 'TinyFish Only', desc: 'Managed cloud browser via TinyFish API.' },
    { id: 'playwright', name: 'Playwright Only', desc: 'Local headless browser — no TinyFish needed.' },
  ];

  const hasTinyFish = (settings.keys.tinyfish?.length ?? 0) > 0;
  const hasKimi = (settings.keys.kimi?.length ?? 0) > 0;

  return (
    <div className="flex flex-col h-full p-5 overflow-y-auto pb-10">
      <div className="mb-6 mt-4 flex items-center gap-3">
        <div className="p-2 bg-white/5 rounded-xl border border-white/10">
          <Settings2 className="w-6 h-6 text-primary" />
        </div>
        <div>
          <h1 className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-white to-white/60">
            Configuration
          </h1>
          <p className="text-xs text-muted-foreground">API keys, models, and browser control.</p>
        </div>
      </div>

      <div className="space-y-8">

        {/* Browser Control */}
        <section className="space-y-3">
          <h2 className="text-sm font-semibold flex items-center gap-2 text-white/80">
            <Globe className="w-4 h-4 text-cyan-400" /> Browser Control
          </h2>
          <p className="text-[10px] text-white/40 leading-relaxed">
            TinyFish is the primary browser controller. When the DOM is unreadable (SPAs, dynamic pages),
            Kimi vision analyzes the screenshot and identifies target elements by their pixel position
            (top-left x/y + dimensions) — not fragile text selectors. Playwright executes those coordinates.
          </p>

          {/* Browser mode selector */}
          <div className="grid grid-cols-1 gap-2">
            {browserModes.map(m => (
              <div
                key={m.id}
                onClick={() => updateSettings({ browserMode: m.id })}
                className={`p-3 rounded-xl border cursor-pointer transition-all ${settings.browserMode === m.id ? 'bg-cyan-500/10 border-cyan-500/40' : 'bg-black/20 border-white/5 hover:bg-white/5'}`}
              >
                <div className="flex justify-between items-center mb-1">
                  <span className={`text-sm font-medium ${settings.browserMode === m.id ? 'text-cyan-300' : 'text-white/70'}`}>{m.name}</span>
                  <div className="flex gap-1">
                    {m.badge && <Badge variant="default" className="text-[9px] bg-cyan-500/20 text-cyan-300 border-cyan-500/30">{m.badge}</Badge>}
                    {settings.browserMode === m.id && <Badge variant="default" className="text-[9px]">Active</Badge>}
                  </div>
                </div>
                <p className="text-[10px] text-white/40">{m.desc}</p>
              </div>
            ))}
          </div>

          {/* TinyFish key */}
          <div className="p-4 rounded-2xl bg-black/30 border border-white/5 space-y-4 mt-2">
            <div>
              <label className="text-xs font-medium text-white/70 mb-1.5 flex items-center justify-between">
                <span className="flex items-center gap-1.5"><MousePointer className="w-3 h-3 text-cyan-400" /> TinyFish API Key</span>
                <span className={`text-[10px] ${hasTinyFish ? 'text-emerald-400' : 'text-white/30'}`}>
                  {hasTinyFish ? '✓ Set — primary browser' : 'Not set — will use Playwright'}
                </span>
              </label>
              <Input
                type="password"
                value={settings.keys.tinyfish}
                onChange={e => updateKey('tinyfish', e.target.value)}
                placeholder="tf-..."
                className="bg-black/80 font-mono text-sm"
              />
              <p className="text-[10px] text-white/30 mt-1">
                Get your key at <span className="text-cyan-400/70">tinyfish.io</span> — managed cloud browser, no local install needed.
              </p>
            </div>

            {/* Kimi key */}
            <div>
              <label className="text-xs font-medium text-white/70 mb-1.5 flex items-center justify-between">
                <span className="flex items-center gap-1.5"><Eye className="w-3 h-3 text-violet-400" /> Kimi Vision API Key (Moonshot AI)</span>
                <span className={`text-[10px] ${hasKimi ? 'text-emerald-400' : 'text-amber-400/60'}`}>
                  {hasKimi ? '✓ Set — vision fallback active' : 'Recommended for SPAs'}
                </span>
              </label>
              <Input
                type="password"
                value={settings.keys.kimi}
                onChange={e => updateKey('kimi', e.target.value)}
                placeholder="sk-..."
                className="bg-black/80 font-mono text-sm"
              />
              <p className="text-[10px] text-white/30 mt-1">
                Kimi identifies elements by pixel position (top-left x, y + width, height) when DOM fails.
                Get your key at <span className="text-violet-400/70">moonshot.cn</span>.
              </p>
              {hasKimi && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  className="mt-2 p-2 rounded-lg bg-violet-500/10 border border-violet-500/20 text-[10px] text-violet-300/70"
                >
                  Vision pipeline: screenshot → Kimi identifies bounding box → Playwright clicks (centerX, centerY)
                </motion.div>
              )}
            </div>
          </div>
        </section>

        {/* Run Mode */}
        <section className="space-y-3">
          <h2 className="text-sm font-semibold flex items-center gap-2 text-white/80">
            <Zap className="w-4 h-4 text-amber-400" /> Run Mode
          </h2>
          <div className="grid grid-cols-1 gap-2">
            {modes.map(m => (
              <div
                key={m.id}
                onClick={() => updateSettings({ mode: m.id })}
                className={`p-3 rounded-xl border cursor-pointer transition-all ${settings.mode === m.id ? 'bg-primary/20 border-primary/50 shadow-[0_0_15px_rgba(139,92,246,0.15)]' : 'bg-black/20 border-white/5 hover:bg-white/5'}`}
              >
                <div className="flex justify-between items-center mb-1">
                  <span className={`text-sm font-medium ${settings.mode === m.id ? 'text-primary-foreground' : 'text-white/80'}`}>{m.name}</span>
                  {settings.mode === m.id && <Badge variant="default" className="text-[9px]">Active</Badge>}
                </div>
                <p className="text-[10px] text-white/50">{m.desc}</p>
              </div>
            ))}
          </div>
        </section>

        {/* LLM Provider */}
        <section className="space-y-3">
          <h2 className="text-sm font-semibold flex items-center gap-2 text-white/80">
            <Cpu className="w-4 h-4 text-blue-400" /> AI Provider
          </h2>
          <div className="grid grid-cols-2 gap-2">
            {llmProviders.map(p => (
              <button
                key={p.id}
                onClick={() => updateSettings({ provider: p.id, model: p.defaultModel })}
                className={`p-3 rounded-xl border text-sm font-medium transition-all text-left ${settings.provider === p.id ? 'bg-primary border-primary text-white shadow-lg shadow-primary/25' : 'bg-black/40 border-white/10 text-white/60 hover:bg-white/10'}`}
              >
                {p.name}
              </button>
            ))}
          </div>

          {settings.provider === 'openrouter' && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="pt-2">
              <label className="text-xs text-white/50 mb-1 block">Custom OpenRouter Model ID</label>
              <Input
                value={settings.customOpenRouterModel}
                onChange={e => updateSettings({ customOpenRouterModel: e.target.value })}
                placeholder="e.g. anthropic/claude-3-opus"
                className="bg-black/60"
              />
            </motion.div>
          )}
        </section>

        {/* LLM API Keys */}
        <section className="space-y-4">
          <h2 className="text-sm font-semibold flex items-center gap-2 text-white/80">
            <Key className="w-4 h-4 text-emerald-400" /> LLM API Keys
          </h2>
          <div className="p-4 rounded-2xl bg-black/30 border border-white/5 space-y-4">
            <p className="text-[10px] text-white/40 mb-2 leading-relaxed">
              Stored in your browser's local storage. Sent to the Nexus backend only when running a task.
            </p>
            {llmProviders.map(p => (
              <div key={p.id} className={settings.provider === p.id ? 'opacity-100' : 'opacity-40 grayscale focus-within:opacity-100 focus-within:grayscale-0 transition-all'}>
                <label className="text-xs font-medium text-white/70 mb-1.5 flex justify-between">
                  {p.name} Key
                  {settings.provider === p.id && <span className="text-primary text-[10px]">Required</span>}
                </label>
                <Input
                  type="password"
                  value={settings.keys[p.id]}
                  onChange={e => updateKey(p.id, e.target.value)}
                  placeholder="sk-..."
                  className="bg-black/80 font-mono text-sm"
                />
              </div>
            ))}
          </div>
        </section>

        <section className="pt-4 pb-8">
          <Button
            className="w-full"
            size="lg"
            onClick={handleSave}
            variant={saved ? 'glass' : 'default'}
          >
            {saved ? 'Saved!' : 'Save Settings'}
          </Button>
        </section>
      </div>
    </div>
  );
}
