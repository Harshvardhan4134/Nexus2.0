import React from 'react';
import { Link, useLocation } from 'wouter';
import { motion, AnimatePresence } from 'framer-motion';
import { Settings, History, PlusCircle, Hexagon } from 'lucide-react';
import { Button } from './ui-elements';

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  return (
    <div className="min-h-screen bg-background flex justify-center relative overflow-hidden text-foreground">
      {/* Abstract Background Effect */}
      <div 
        className="absolute inset-0 z-0 opacity-40 mix-blend-screen pointer-events-none"
        style={{
          backgroundImage: `url(${import.meta.env.BASE_URL}images/bg-mesh.png)`,
          backgroundSize: 'cover',
          backgroundPosition: 'center'
        }}
      />
      
      {/* Lighting Orbs */}
      <div className="absolute top-[-20%] left-[-10%] w-[500px] h-[500px] bg-primary/20 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-20%] right-[-10%] w-[400px] h-[400px] bg-blue-500/10 rounded-full blur-[100px] pointer-events-none" />

      {/* Main Extension-like Container */}
      <main className="w-full max-w-[420px] h-screen sm:h-[95vh] sm:my-auto sm:rounded-[32px] glass-panel flex flex-col relative z-10 overflow-hidden shadow-2xl shadow-black/50">
        
        {/* Header */}
        <header className="flex items-center justify-between px-5 py-4 border-b border-white/5 bg-black/20 backdrop-blur-md z-20">
          <Link href="/" className="flex items-center gap-2 group cursor-pointer">
            <div className="relative flex items-center justify-center w-8 h-8 rounded-lg bg-gradient-to-br from-primary/80 to-primary/20 shadow-[0_0_15px_rgba(139,92,246,0.3)] group-hover:shadow-[0_0_25px_rgba(139,92,246,0.6)] transition-all duration-300">
              <Hexagon className="w-5 h-5 text-white" />
            </div>
            <span className="font-display font-bold text-xl tracking-wide bg-clip-text text-transparent bg-gradient-to-r from-white to-white/60">
              NEXUS
            </span>
          </Link>

          <div className="flex items-center gap-1">
            <Link href="/">
              <Button variant="ghost" size="icon" className={cn("w-9 h-9 rounded-full", location === '/' && "bg-white/10")}>
                <PlusCircle className="w-4 h-4 text-muted-foreground hover:text-white transition-colors" />
              </Button>
            </Link>
            <Link href="/history">
              <Button variant="ghost" size="icon" className={cn("w-9 h-9 rounded-full", location === '/history' && "bg-white/10")}>
                <History className="w-4 h-4 text-muted-foreground hover:text-white transition-colors" />
              </Button>
            </Link>
            <Link href="/settings">
              <Button variant="ghost" size="icon" className={cn("w-9 h-9 rounded-full", location === '/settings' && "bg-white/10")}>
                <Settings className="w-4 h-4 text-muted-foreground hover:text-white transition-colors" />
              </Button>
            </Link>
          </div>
        </header>

        {/* Page Content with Transitions */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden relative scroll-smooth">
          <AnimatePresence mode="wait">
            <motion.div
              key={location}
              initial={{ opacity: 0, y: 10, filter: "blur(4px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0, y: -10, filter: "blur(4px)" }}
              transition={{ duration: 0.3, ease: "easeOut" }}
              className="min-h-full flex flex-col"
            >
              {children}
            </motion.div>
          </AnimatePresence>
        </div>
      </main>
    </div>
  );
}

// Simple CN utility for this file since we can't easily import from sibling if it's not set up
function cn(...classes: (string | undefined | null | false)[]) {
  return classes.filter(Boolean).join(' ');
}
