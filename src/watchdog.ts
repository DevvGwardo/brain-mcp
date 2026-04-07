#!/usr/bin/env node
/**
 * Brain Persistent Watchdog — survives lead session crashes.
 * Runs as a detached child process, checks for stale agents every 15s.
 */

import { BrainDB } from './db.js';
import { randomUUID } from 'node:crypto';

const dbPath = process.env.BRAIN_DB_PATH || `${process.env.HOME}/.claude/brain/brain.db`;
const room = process.env.BRAIN_ROOM || process.cwd();
const pollInterval = 15000; // 15 seconds

function log(msg: string) {
  console.error(`[watchdog ${new Date().toISOString()}] ${msg}`);
}

async function main() {
  log(`Starting watchdog for room: ${room}, db: ${dbPath}`);
  
  const db = new BrainDB(dbPath);
  let lastStaleAlerts: string[] = [];
  
  while (true) {
    try {
      await new Promise(r => setTimeout(r, pollInterval));
      
      const agents = db.getAgentHealth(room);
      const conductorAgent = agents.find(a => a.name.includes('conductor') || a.name === 'conductor');
      const otherAgents = agents.filter(a => a.id !== conductorAgent?.id);
      
      // Check for newly stale agents
      const newlyStale = otherAgents.filter(a => a.is_stale && !lastStaleAlerts.includes(a.id));
      if (newlyStale.length > 0) {
        log(`Detected stale agents: ${newlyStale.map(a => `${a.name}(${a.heartbeat_age_seconds}s)`).join(', ')}`);
        
        // Post to alerts channel
        for (const agent of newlyStale) {
          db.postMessage(
            'alerts',
            room,
            'watchdog',
            'watchdog',
            `STALE: ${agent.name} (${agent.heartbeat_age_seconds}s since heartbeat, status=${agent.status})`
          );
        }
        
        // Update stale tracking
        lastStaleAlerts = [...lastStaleAlerts, ...newlyStale.map(a => a.id)];
      }
      
      // Clean up tracking for agents that recovered
      lastStaleAlerts = lastStaleAlerts.filter(id => {
        const agent = agents.find(a => a.id === id);
        return agent && agent.is_stale;
      });
      
      // Check for agents that exited without recording exit code
      for (const agent of otherAgents) {
        if (agent.status === 'working' && agent.heartbeat_age_seconds > 120) {
          // Agent is very stale (>2 min) — check if process is actually dead
          // In a real implementation, you'd check the process table
          // For now, post an alert
          log(`Agent ${agent.name} very stale (${agent.heartbeat_age_seconds}s), may have crashed silently`);
        }
      }
      
    } catch (err) {
      log(`Error in watchdog loop: ${err}`);
    }
  }
}

main().catch(err => {
  console.error(`Watchdog fatal error: ${err}`);
  process.exit(1);
});