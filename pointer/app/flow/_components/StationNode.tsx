"use client";

import { Handle, type NodeProps, Position } from "@xyflow/react";
import { Fragment } from "react";

export interface StationNodeData {
  label: string;
  accent: string;
  subtitle?: string;
  [key: string]: unknown;
}

const HANDLE_POS = {
  t: Position.Top,
  r: Position.Right,
  b: Position.Bottom,
  l: Position.Left,
} as const;
type HandleKey = keyof typeof HANDLE_POS;

const HIDDEN: React.CSSProperties = {
  width: 1,
  height: 1,
  background: "transparent",
  border: "none",
  opacity: 0,
};

export function StationNode({
  data,
}: NodeProps & { data: StationNodeData }) {
  return (
    <div
      className="rounded-xl border-2 bg-white px-4 py-3 text-center text-[13px] font-medium text-zinc-900 shadow-sm dark:bg-zinc-950 dark:text-zinc-50"
      style={{
        borderColor: data.accent,
        minWidth: 150,
        whiteSpace: "pre-line",
      }}
    >
      {(Object.keys(HANDLE_POS) as HandleKey[]).map((k) => (
        <Fragment key={k}>
          <Handle
            id={`s-${k}`}
            type="source"
            position={HANDLE_POS[k]}
            style={HIDDEN}
            isConnectable={false}
          />
          <Handle
            id={`t-${k}`}
            type="target"
            position={HANDLE_POS[k]}
            style={HIDDEN}
            isConnectable={false}
          />
        </Fragment>
      ))}
      <div>{data.label}</div>
      {data.subtitle ? (
        <div className="mt-0.5 text-[10px] font-normal text-zinc-500 dark:text-zinc-400">
          {data.subtitle}
        </div>
      ) : null}
    </div>
  );
}
