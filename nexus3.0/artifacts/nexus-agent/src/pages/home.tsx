import React, { useState } from 'react';
import { useLocation } from 'wouter';
import { motion } from 'framer-motion';
import { ArrowRight, Globe, Mic, Paperclip, Send, MousePointerClick, CheckCircle2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui-elements';
import { useSettings } from '@/hooks/use-settings';
import { useSpeech } from '@/hooks/use-speech';
import { useRunAgent } from '@workspace/api-client-react';
import { cn } from '@/lib/utils';

export default function Home() {
  const [task, setTask] = useState('');
  const [, setLocation] = useLocation();
  const { settings, updateSettings } = useSettings();
  const { isListening, transcript, startListening, stopListening } = useSpeech();
  
  const runAgentMutation = useRunAgent({
    mutation: {
      onSuccess: (data) => {
        setLocation(`/session/${data.sessionId}`);
      }
    }
  });

  // Sync speech transcript to input
  React.useEffect(() => {
    if (isListening && transcript) {
      setTask(transcript);
    }
  }, [transcript, isListening]);

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!task.trim()) return;

    const apiKey = settings.keys[settings.provider];

    runAgentMutation.mutate({
      data: {
        task,
        provider: settings.provider,
        model: settings.provider === 'openrouter' && settings.customOpenRouterModel
                ? settings.customOpenRouterModel
                : settings.model,
        apiKey,
        mode: settings.mode,
        tinyfishKey: settings.keys.tinyfish || undefined,
        kimiKey: settings.keys.kimi || undefined,
        browserMode: settings.browserMode,
        useChromeExtension: settings.useChromeExtension,
      }
    });
  };

  const SUGGESTIONS = [
    "Search GitHub for the best open-source AI projects",
    "Look up Python list comprehension on Wikipedia",
    "Find top AI news on DuckDuckGo and summarize results",
  ];

  return (
    <div className="flex flex-col h-full p-5 pt-8">
      <div className="flex-1 flex flex-col justify-center pb-20">
        
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="text-center mb-10"
        >
          <div className="inline-flex items-center justify-center p-3 mb-6 rounded-2xl bg-white/5 border border-white/10 shadow-inner">
            <Sparkles className="w-8 h-8 text-primary" />
          </div>
          <h1 className="text-3xl font-display font-bold text-transparent bg-clip-text bg-gradient-to-br from-white to-white/50 mb-4">
            How can I help you today?
          </h1>
          <p className="text-muted-foreground text-sm leading-relaxed max-w-[280px] mx-auto">
            An AI that uses the internet for you. It searches, opens sites, clicks, fills forms, and completes tasks.
          </p>
        </motion.div>

        {/* Suggestion Cards */}
        <div className="space-y-3">
          {SUGGESTIONS.map((sug, i) => (
            <motion.button
              key={i}
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.2 + (i * 0.1) }}
              onClick={() => setTask(sug)}
              className="w-full text-left glass-card p-4 group"
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-white/80 group-hover:text-white transition-colors">"{sug}"</span>
                <ArrowRight className="w-4 h-4 text-white/20 group-hover:text-primary transition-colors transform group-hover:translate-x-1" />
              </div>
            </motion.button>
          ))}
        </div>

        {/* Active Task Sneak Peek (Visual fluff to show capability) */}
        <motion.div 
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.6 }}
          className="mt-10 p-4 rounded-2xl bg-gradient-to-b from-primary/10 to-transparent border border-primary/20 relative overflow-hidden"
        >
          <div className="absolute inset-0 bg-[url('https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?q=80&w=2564&auto=format&fit=crop')] opacity-5 mix-blend-overlay"></div>
          {/* unsplash tech abstract pattern */}
          <div className="flex items-center gap-3 mb-3 relative z-10">
            <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-xs font-medium text-emerald-400">Agent Capabilities</span>
          </div>
          <div className="space-y-2 relative z-10">
            <div className="flex items-center gap-2 text-xs text-white/60">
              <CheckCircle2 className="w-3.5 h-3.5 text-primary" />
              Navigating websites
            </div>
            <div className="flex items-center gap-2 text-xs text-white/60">
              <MousePointerClick className="w-3.5 h-3.5 text-primary" />
              Clicking and filling forms
            </div>
            <div className="flex items-center gap-2 text-xs text-white/60">
              <Globe className="w-3.5 h-3.5 text-primary" />
              Extracting structured data
            </div>
          </div>
        </motion.div>
      </div>

      {/* Input Area (Fixed at bottom of scroll area) */}
      <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-background via-background/95 to-transparent pt-10">
        <form onSubmit={handleSubmit} className="relative group">
          <div className="absolute -inset-1 bg-gradient-to-r from-primary/30 to-blue-500/30 rounded-[1.5rem] blur opacity-20 group-hover:opacity-40 transition duration-500"></div>
          
          <div className="relative flex flex-col bg-black/60 backdrop-blur-xl border border-white/10 rounded-2xl overflow-hidden focus-within:border-primary/50 transition-colors">
            <textarea
              value={task}
              onChange={(e) => setTask(e.target.value)}
              placeholder="Ask Nexus to do something..."
              className="w-full bg-transparent p-4 min-h-[80px] max-h-[150px] resize-none text-sm text-white placeholder:text-white/30 focus:outline-none"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
            />
            
            <div className="flex items-center justify-between p-2 pt-0">
              <div className="flex items-center gap-1">
                <Button type="button" variant="ghost" size="icon" className="w-8 h-8 rounded-lg text-white/40 hover:text-white hover:bg-white/10">
                  <Paperclip className="w-4 h-4" />
                </Button>
                <Button type="button" variant="ghost" size="icon" className="w-8 h-8 rounded-lg text-white/40 hover:text-white hover:bg-white/10">
                  <Globe className="w-4 h-4" />
                </Button>
                <Button 
                  type="button" 
                  variant="ghost" 
                  size="icon" 
                  onClick={isListening ? stopListening : startListening}
                  className={cn("w-8 h-8 rounded-lg transition-colors", isListening ? "text-red-400 bg-red-400/10 hover:bg-red-400/20" : "text-white/40 hover:text-white hover:bg-white/10")}
                >
                  <Mic className={cn("w-4 h-4", isListening && "animate-pulse")} />
                </Button>
              </div>
              
              <Button 
                type="submit" 
                size="icon" 
                isLoading={runAgentMutation.isPending}
                disabled={!task.trim()}
                className="w-8 h-8 rounded-lg bg-primary hover:bg-primary/90 text-white disabled:opacity-30 disabled:bg-white/10"
              >
                {!runAgentMutation.isPending && <Send className="w-4 h-4 ml-0.5" />}
              </Button>
            </div>
          </div>
        </form>
        <label className="flex items-center justify-center gap-2 mt-3 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={settings.useChromeExtension}
            onChange={(e) => updateSettings({ useChromeExtension: e.target.checked })}
            className="rounded border-white/20 bg-white/5"
          />
          <span className="text-[11px] text-white/50">
            Use my Chrome (Nexus extension — default). Uncheck for server Playwright.
          </span>
        </label>
        <p className="text-center text-[10px] text-white/20 mt-2">
          {settings.useChromeExtension
            ? 'Load unpacked extension from artifacts/nexus-extension/dist, reload it after rebuilds, API on :8080.'
            : 'Runs Playwright on the machine that hosts the API (not your everyday Chrome tab).'}
        </p>
      </div>
    </div>
  );
}
