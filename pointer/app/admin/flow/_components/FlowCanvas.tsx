"use client";

import {
  Background,
  Controls,
  type Edge,
  type EdgeTypes,
  MarkerType,
  type Node,
  type NodeTypes,
  ReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMemo } from "react";

import type { EdgeId, NodeId } from "../_lib/mapping";
import { useEventStream } from "../_lib/useEventStream";

import { EventLog } from "./EventLog";
import { PulseEdge, type PulseEdgeData } from "./PulseEdge";
import { StationNode, type StationNodeData } from "./StationNode";

const nodeTypes: NodeTypes = { station: StationNode };
const edgeTypes: EdgeTypes = { pulse: PulseEdge };

const NODES: Array<Node<StationNodeData>> = [
  {
    id: "n_user" satisfies NodeId,
    type: "station",
    position: { x: 0, y: 240 },
    data: { label: "User", accent: "#0ea5e9" },
  },
  {
    id: "n_app" satisfies NodeId,
    type: "station",
    position: { x: 280, y: 240 },
    data: {
      label: "Pointer App",
      subtitle: "Better Auth",
      accent: "#6366f1",
    },
  },
  {
    id: "n_cbapi" satisfies NodeId,
    type: "station",
    position: { x: 280, y: 60 },
    data: { label: "Chargebee API", accent: "#f59e0b" },
  },
  {
    id: "n_cbwebhook" satisfies NodeId,
    type: "station",
    position: { x: 560, y: 60 },
    data: {
      label: "Chargebee Webhook",
      subtitle: "inbound",
      accent: "#f59e0b",
    },
  },
  {
    id: "n_queue" satisfies NodeId,
    type: "station",
    position: { x: 560, y: 240 },
    data: {
      label: "SQS Queue",
      subtitle: "webhook inbox",
      accent: "#a855f7",
    },
  },
  {
    id: "n_worker" satisfies NodeId,
    type: "station",
    position: { x: 820, y: 240 },
    data: {
      label: "Webhook Worker",
      subtitle: "async consumer",
      accent: "#6366f1",
    },
  },
  {
    id: "n_db" satisfies NodeId,
    type: "station",
    position: { x: 560, y: 400 },
    data: { label: "Postgres", accent: "#10b981" },
  },
];

interface StaticEdge {
  id: EdgeId;
  source: NodeId;
  target: NodeId;
  sourceHandle: string;
  targetHandle: string;
  baseLabel: string;
  smoothstep?: boolean;
}

const STATIC_EDGES: StaticEdge[] = [
  {
    id: "e_user_app",
    source: "n_user",
    target: "n_app",
    sourceHandle: "s-r",
    targetHandle: "t-l",
    baseLabel: "sign-up",
  },
  {
    id: "e_app_cbapi",
    source: "n_app",
    target: "n_cbapi",
    sourceHandle: "s-t",
    targetHandle: "t-b",
    baseLabel: "customer.create",
  },
  {
    id: "e_cbapi_cbwebhook",
    source: "n_cbapi",
    target: "n_cbwebhook",
    sourceHandle: "s-r",
    targetHandle: "t-l",
    baseLabel: "fan-out",
    smoothstep: true,
  },
  {
    id: "e_cbwebhook_app",
    source: "n_cbwebhook",
    target: "n_app",
    sourceHandle: "s-b",
    targetHandle: "t-r",
    baseLabel: "webhook POST",
    smoothstep: true,
  },
  {
    id: "e_app_queue",
    source: "n_app",
    target: "n_queue",
    sourceHandle: "s-r",
    targetHandle: "t-l",
    baseLabel: "enqueue",
  },
  {
    id: "e_queue_worker",
    source: "n_queue",
    target: "n_worker",
    sourceHandle: "s-r",
    targetHandle: "t-l",
    baseLabel: "dequeue",
  },
  {
    id: "e_worker_db",
    source: "n_worker",
    target: "n_db",
    sourceHandle: "s-b",
    targetHandle: "t-r",
    baseLabel: "DB sync",
    smoothstep: true,
  },
  {
    id: "e_app_db",
    source: "n_app",
    target: "n_db",
    sourceHandle: "s-b",
    targetHandle: "t-l",
    baseLabel: "INSERT user",
    smoothstep: true,
  },
];

export function FlowCanvas() {
  const state = useEventStream();

  const edges = useMemo<Edge[]>(() => {
    return STATIC_EDGES.map((e) => {
      const pulses = state.activeEdges[e.id] ?? [];
      const active = pulses.length > 0;
      const latestTag = pulses[pulses.length - 1]?.tag;
      const data: PulseEdgeData = {
        baseLabel: e.baseLabel,
        pulses,
        smoothstep: e.smoothstep,
        activeTag: latestTag,
      };
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle,
        targetHandle: e.targetHandle,
        type: "pulse",
        animated: active,
        data,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: active ? "#6366f1" : "#64748b",
          width: 14,
          height: 14,
        },
        style: {
          stroke: active ? "#6366f1" : "#94a3b8",
          strokeWidth: active ? 2.5 : 1.5,
          transition: "stroke 200ms ease, stroke-width 200ms ease",
        },
      } satisfies Edge;
    });
  }, [state.activeEdges]);

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col gap-4 px-6 py-6 lg:flex-row">
      <div className="relative h-[60vh] flex-1 overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950 lg:h-auto">
        <div className="absolute right-3 top-3 z-10 flex items-center gap-2 rounded-full bg-white/80 px-3 py-1 text-xs font-medium text-zinc-700 backdrop-blur dark:bg-zinc-900/80 dark:text-zinc-200">
          <span
            className={`h-2 w-2 rounded-full ${
              state.connected ? "bg-emerald-500" : "bg-amber-500"
            }`}
          />
          {state.connected ? "Live" : state.lastError ?? "Connecting…"}
        </div>
        <Legend />
        <ReactFlow
          nodes={NODES}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={20} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <EventLog events={state.events} />
    </div>
  );
}

function Legend() {
  const items: Array<{
    label: string;
    shape: "circle" | "triangle" | "square" | "diamond";
    color: string;
  }> = [
    { label: "app.user_created", shape: "circle", color: "#0ea5e9" },
    { label: "chargebee.customer_created", shape: "triangle", color: "#f59e0b" },
    { label: "chargebee.webhook_received", shape: "square", color: "#10b981" },
    { label: "chargebee.webhook_queued", shape: "diamond", color: "#a855f7" },
    { label: "chargebee.webhook_processed", shape: "circle", color: "#6366f1" },
  ];
  return (
    <div className="absolute bottom-3 left-3 z-10 flex flex-col gap-1 rounded-lg bg-white/80 px-3 py-2 text-[11px] font-medium text-zinc-700 backdrop-blur dark:bg-zinc-900/80 dark:text-zinc-200">
      {items.map((it) => (
        <div key={it.label} className="flex items-center gap-2">
          <svg width="14" height="14" viewBox="-8 -8 16 16">
            {it.shape === "circle" ? (
              <circle r={6} fill={it.color} stroke="#fff" strokeWidth={1} />
            ) : it.shape === "triangle" ? (
              <polygon
                points="0,-7 6,5 -6,5"
                fill={it.color}
                stroke="#fff"
                strokeWidth={1}
              />
            ) : it.shape === "square" ? (
              <rect
                x={-5}
                y={-5}
                width={10}
                height={10}
                rx={1.5}
                fill={it.color}
                stroke="#fff"
                strokeWidth={1}
              />
            ) : (
              <polygon
                points="0,-7 7,0 0,7 -7,0"
                fill={it.color}
                stroke="#fff"
                strokeWidth={1}
              />
            )}
          </svg>
          <span className="font-mono">{it.label}</span>
        </div>
      ))}
    </div>
  );
}
