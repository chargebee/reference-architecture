"use client";

import {
  BaseEdge,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
  getSmoothStepPath,
} from "@xyflow/react";

import type { EdgePulse } from "../_lib/useEventStream";

import { ANIMATION_S, EdgeLabel } from "./EdgeLabel";

export interface PulseEdgeData {
  baseLabel: string;
  pulses: EdgePulse[];
  smoothstep?: boolean;
  activeTag?: string;
  [key: string]: unknown;
}

export function PulseEdge(props: EdgeProps & { data?: PulseEdgeData }) {
  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    markerEnd,
    style,
    data,
  } = props;

  const pathFn = data?.smoothstep ? getSmoothStepPath : getBezierPath;
  const [edgePath, labelX, labelY] = pathFn({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  const pulses = data?.pulses ?? [];

  return (
    <>
      <BaseEdge id={id} path={edgePath} style={style} markerEnd={markerEnd} />

      {pulses.map((pulse) => (
        <PulseShape key={pulse.id} pulse={pulse} path={edgePath} />
      ))}

      <EdgeLabelRenderer>
        <div
          style={{
            position: "absolute",
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: "none",
          }}
          className="nodrag nopan"
        >
          <EdgeLabel
            baseLabel={data?.baseLabel ?? ""}
            tag={data?.activeTag}
          />
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

function PulseShape({ pulse, path }: { pulse: EdgePulse; path: string }) {
  const shape = renderShape(pulse);
  return (
    <g style={{ pointerEvents: "none" }}>
      {shape}
      <animateMotion
        dur={`${ANIMATION_S}s`}
        repeatCount="1"
        path={path}
        fill="freeze"
        rotate="auto"
      />
    </g>
  );
}

function renderShape({ shape, color }: EdgePulse) {
  const stroke = "#ffffff";
  const strokeWidth = 1.5;
  switch (shape) {
    case "circle":
      return (
        <circle
          r={7}
          fill={color}
          stroke={stroke}
          strokeWidth={strokeWidth}
        />
      );
    case "triangle":
      return (
        <polygon
          points="0,-8 7,5 -7,5"
          fill={color}
          stroke={stroke}
          strokeWidth={strokeWidth}
        />
      );
    case "square":
      return (
        <rect
          x={-6}
          y={-6}
          width={12}
          height={12}
          rx={2}
          fill={color}
          stroke={stroke}
          strokeWidth={strokeWidth}
        />
      );
    case "diamond":
    default:
      return (
        <polygon
          points="0,-8 8,0 0,8 -8,0"
          fill={color}
          stroke={stroke}
          strokeWidth={strokeWidth}
        />
      );
  }
}
