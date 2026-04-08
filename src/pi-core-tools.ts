/**
 * Brain tools wrapped as pi-agent-core AgentTools.
 * These are the coordination primitives exposed to in-process pi-core agents.
 */

import { Type, } from '@sinclair/typebox';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { BrainDB } from './db.js';
import type { SessionStatus } from './db.js';

// ── Tool Result helper ──────────────────────────────────────────────────────

function ok<T>(data: T) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] as any, details: data };
}

function err(message: string) {
  return { content: [{ type: 'text' as const, text: `ERROR: ${message}` }] as any, details: { error: message }, isError: true };
}

// ── Tool definitions ────────────────────────────────────────────────────────

export function createBrainTools(
  db: BrainDB,
  sessionId: string,
  room: string,
): AgentTool<any>[] {
  return [
    // ── Pulse (heartbeat) ─────────────────────────────────────────────────
    {
      name: 'brain_pulse',
      label: 'Brain Pulse',
      description: 'Send a heartbeat to the conductor. Call every few tool invocations to report that you are alive and making progress.',
      parameters: Type.Object({
        status: Type.String({ description: 'Current status: working, done, failed, idle' }),
        progress: Type.Optional(Type.String({ description: 'Short human-readable progress description' })),
      }),
      execute: async (toolCallId, { status, progress }) => {
        try {
          db.pulse(sessionId, status as SessionStatus, progress);
          return ok({ ok: true, status, progress: progress ?? null });
        } catch (e: any) {
          return err(`pulse failed: ${e.message}`);
        }
      },
    },

    // ── Post message ─────────────────────────────────────────────────────
    {
      name: 'brain_post',
      label: 'Brain Post',
      description: 'Post a message to a channel in the brain room. Use channel "general" for team-wide updates, "alerts" for important notifications.',
      parameters: Type.Object({
        content: Type.String({ description: 'Message content to post' }),
        channel: Type.Optional(Type.String({ description: 'Channel name (default: "general")' })),
      }),
      execute: async (toolCallId, { content, channel }) => {
        try {
          const ch = channel || 'general';
          db.postMessage(ch, room, sessionId, 'pi-core-agent', content);
          return ok({ ok: true, channel: ch });
        } catch (e: any) {
          return err(`post failed: ${e.message}`);
        }
      },
    },

    // ── Set shared state ──────────────────────────────────────────────────
    {
      name: 'brain_set',
      label: 'Brain Set',
      description: 'Store a key-value pair in shared brain state. Other agents can read it with brain_get. Values must be JSON-serializable strings.',
      parameters: Type.Object({
        key: Type.String({ description: 'State key name' }),
        value: Type.String({ description: 'Value to store (string — use JSON.stringify for objects)' }),
        scope: Type.Optional(Type.String({ description: 'Scope/keyspace (default: current room)' })),
      }),
      execute: async (toolCallId, { key, value, scope }) => {
        try {
          const s = scope || room;
          db.setState(key, s, value, sessionId, 'pi-core-agent');
          return ok({ ok: true, key, scope: s });
        } catch (e: any) {
          return err(`set failed: ${e.message}`);
        }
      },
    },

    // ── Get shared state ──────────────────────────────────────────────────
    {
      name: 'brain_get',
      label: 'Brain Get',
      description: 'Read a value from shared brain state. Returns null if the key does not exist.',
      parameters: Type.Object({
        key: Type.String({ description: 'State key to read' }),
        scope: Type.Optional(Type.String({ description: 'Scope/keyspace (default: current room)' })),
      }),
      execute: async (toolCallId, { key, scope }) => {
        try {
          const s = scope || room;
          const entry = db.getState(key, s);
          return ok({
            found: !!entry,
            key,
            scope: s,
            value: entry?.value ?? null,
            updated_by: entry?.updated_by ?? null,
            updated_at: entry?.updated_at ?? null,
          });
        } catch (e: any) {
          return err(`get failed: ${e.message}`);
        }
      },
    },

    // ── Atomic increment ──────────────────────────────────────────────────
    {
      name: 'brain_incr',
      label: 'Brain Incr',
      description: 'Atomically increment a numeric counter in shared state. Thread-safe — use for shared counters, progress tracking, or aggregation across agents.',
      parameters: Type.Object({
        key: Type.String({ description: 'Counter key name' }),
        delta: Type.Optional(Type.Number({ description: 'Amount to increment by (default: 1)' })),
        scope: Type.Optional(Type.String({ description: 'Scope (default: current room)' })),
      }),
      execute: async (toolCallId, { key, delta, scope }) => {
        try {
          const s = scope || room;
          const result = db.incr(key, s, delta ?? 1);
          return ok(result);
        } catch (e: any) {
          return err(`incr failed: ${e.message}`);
        }
      },
    },

    // ── Atomic decrement ──────────────────────────────────────────────────
    {
      name: 'brain_decr',
      label: 'Brain Decr',
      description: 'Atomically decrement a numeric counter.',
      parameters: Type.Object({
        key: Type.String({ description: 'Counter key name' }),
        delta: Type.Optional(Type.Number({ description: 'Amount to decrement by (default: 1)' })),
        scope: Type.Optional(Type.String({ description: 'Scope (default: current room)' })),
      }),
      execute: async (toolCallId, { key, delta, scope }) => {
        try {
          const s = scope || room;
          const result = db.decr(key, s, delta ?? 1);
          return ok(result);
        } catch (e: any) {
          return err(`decr failed: ${e.message}`);
        }
      },
    },

    // ── Get counter ───────────────────────────────────────────────────────
    {
      name: 'brain_counter',
      label: 'Brain Counter',
      description: 'Get the current value of an atomic counter without incrementing.',
      parameters: Type.Object({
        key: Type.String({ description: 'Counter key name' }),
        scope: Type.Optional(Type.String({ description: 'Scope (default: current room)' })),
      }),
      execute: async (toolCallId, { key, scope }) => {
        try {
          const s = scope || room;
          const counter = db.get_counter(key, s);
          return ok({ key, scope: s, value: counter.value, found: counter.found });
        } catch (e: any) {
          return err(`counter failed: ${e.message}`);
        }
      },
    },

    // ── Barrier wait ──────────────────────────────────────────────────────
    {
      name: 'brain_wait_until',
      label: 'Brain Barrier',
      description: 'Barrier primitive — atomically increment a counter. When current >= threshold, returns reached:true for all callers simultaneously. Use for "wait for N agents to check in" semantics.',
      parameters: Type.Object({
        key: Type.String({ description: 'Barrier identifier (descriptive name)' }),
        threshold: Type.Number({ description: 'Number of agents that must call before barrier releases' }),
        scope: Type.Optional(Type.String({ description: 'Scope (default: current room)' })),
      }),
      execute: async (toolCallId, { key, threshold, scope }) => {
        try {
          const s = scope || room;
          const result = db.wait_on(key, s, threshold, sessionId, 'pi-core-agent');
          return ok(result);
        } catch (e: any) {
          return err(`wait_on failed: ${e.message}`);
        }
      },
    },

    // ── Barrier status ─────────────────────────────────────────────────────
    {
      name: 'brain_barrier_status',
      label: 'Brain Barrier Status',
      description: 'Check the current status of a barrier — how many agents have checked in and what the threshold is.',
      parameters: Type.Object({
        key: Type.String({ description: 'Barrier key' }),
        scope: Type.Optional(Type.String({ description: 'Scope (default: current room)' })),
      }),
      execute: async (toolCallId, { key, scope }) => {
        try {
          const s = scope || room;
          const barrier = db.get_barrier(key, s);
          if (!barrier) return ok({ found: false, key, scope: s });
          return ok({ found: true, ...barrier });
        } catch (e: any) {
          return err(`barrier_status failed: ${e.message}`);
        }
      },
    },

    // ── Task result ────────────────────────────────────────────────────────
    {
      name: 'brain_set_task_result',
      label: 'Brain Set Task Result',
      description: 'Attach a result blob to a DAG task. Dependent tasks can retrieve it with brain_get_task_result.',
      parameters: Type.Object({
        task_id: Type.String({ description: 'Task ID from brain_plan' }),
        plan_id: Type.String({ description: 'Plan ID from brain_plan' }),
        result: Type.String({ description: 'JSON-serializable result string' }),
      }),
      execute: async (toolCallId, { task_id, plan_id, result }) => {
        try {
          db.set_task_result(task_id, plan_id, result);
          return ok({ ok: true, task_id, plan_id });
        } catch (e: any) {
          return err(`set_task_result failed: ${e.message}`);
        }
      },
    },

    // ── Get task result ────────────────────────────────────────────────────
    {
      name: 'brain_get_task_result',
      label: 'Brain Get Task Result',
      description: 'Get the result blob from a completed DAG task. Returns null if the task has not posted a result.',
      parameters: Type.Object({
        task_id: Type.String({ description: 'Task ID from brain_plan' }),
      }),
      execute: async (toolCallId, { task_id }) => {
        try {
          const result = db.get_task_result(task_id);
          return ok({ found: !!result, task_id, result: result ? JSON.parse(result) : null });
        } catch (e: any) {
          return err(`get_task_result failed: ${e.message}`);
        }
      },
    },

    // ── Brain status ───────────────────────────────────────────────────────
    {
      name: 'brain_status',
      label: 'Brain Status',
      description: 'Get current brain room status — self session info and room statistics.',
      parameters: Type.Object({}),
      execute: async (toolCallId, {}) => {
        try {
          const self = db.getSession(sessionId);
          return ok({ self, room, roomLabel: room.split('/').pop() });
        } catch (e: any) {
          return err(`status failed: ${e.message}`);
        }
      },
    },

    // ── Brain agents ──────────────────────────────────────────────────────
    {
      name: 'brain_agents',
      label: 'Brain Agents',
      description: 'Get health and status of all agents in the current brain room.',
      parameters: Type.Object({}),
      execute: async (toolCallId, {}) => {
        try {
          const agents = db.getAgentHealth(room);
          return ok({ agents, room });
        } catch (e: any) {
          return err(`agents failed: ${e.message}`);
        }
      },
    },
  ];
}
