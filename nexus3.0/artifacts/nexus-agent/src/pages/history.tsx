import React from 'react';
import { Link } from 'wouter';
import { motion } from 'framer-motion';
import { Clock, ChevronRight, InboxIcon } from 'lucide-react';
import { useGetSessions } from '@workspace/api-client-react';
import { Badge } from '@/components/ui-elements';

export default function History() {
  const { data, isLoading } = useGetSessions();

  return (
    <div className="flex flex-col h-full p-5">
      <div className="mb-6 mt-4">
        <h1 className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-white to-white/60">
          History
        </h1>
        <p className="text-sm text-muted-foreground mt-1">Your recent automation tasks.</p>
      </div>

      <div className="flex-1 overflow-y-auto pr-1 space-y-3 pb-8">
        {isLoading ? (
          Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-24 w-full rounded-2xl bg-white/5 animate-pulse border border-white/5" />
          ))
        ) : !data?.sessions || data.sessions.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-white/30 space-y-3">
            <InboxIcon className="w-12 h-12 opacity-50" />
            <p className="text-sm">No tasks run yet.</p>
          </div>
        ) : (
          data.sessions.map((session, i) => (
            <Link href={`/session/${session.id}`} key={session.id}>
              <motion.a 
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.05 }}
                className="block p-4 glass-card group cursor-pointer"
              >
                <div className="flex justify-between items-start mb-2">
                  <Badge variant={
                    session.status === 'running' ? 'default' :
                    session.status === 'completed' ? 'success' :
                    session.status === 'error' ? 'error' : 'outline'
                  } className="text-[10px]">
                    {session.status}
                  </Badge>
                  <div className="flex items-center text-[10px] text-muted-foreground font-mono">
                    <Clock className="w-3 h-3 mr-1" />
                    {new Date(session.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  </div>
                </div>
                
                <h3 className="text-sm font-medium text-white/90 line-clamp-2 mb-3 leading-snug group-hover:text-white transition-colors">
                  {session.task}
                </h3>
                
                <div className="flex items-center justify-between mt-auto">
                  <div className="text-xs text-white/40 font-mono bg-black/30 px-2 py-0.5 rounded border border-white/5">
                    {session.model || 'Unknown'} • {session.stepCount || 0} steps
                  </div>
                  <ChevronRight className="w-4 h-4 text-white/20 group-hover:text-primary transition-all group-hover:translate-x-1" />
                </div>
              </motion.a>
            </Link>
          ))
        )}
      </div>
    </div>
  );
}
