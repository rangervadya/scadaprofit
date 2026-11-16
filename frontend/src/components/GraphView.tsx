import { useMemo } from 'react';
import type { JobGraph } from '../lib/types';

type Props = {
  graph: JobGraph;
  visibleEdges: Set<string>;
  showNodes: boolean;
  showCrossings: boolean;
  selectedEdge: string | null;
  onSelectEdge?: (id: string) => void;
};

export function GraphView({ graph, visibleEdges, showNodes, showCrossings, selectedEdge, onSelectEdge }: Props) {
  const { width, height } = graph.image || { width: 1000, height: 800 };
  const nodes = useMemo(() => new Map(graph.nodes.map(node => [node.id, node])), [graph.nodes]);

  return (
    <div className="canvas-frame">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Схема газопровода">
        {graph.sourceUrl ? <image href={graph.sourceUrl} x="0" y="0" width={width} height={height} preserveAspectRatio="none" /> : null}
        <g>
          {graph.edges.map(edge => {
            const visible = visibleEdges.has(edge.id) && edge.visible !== false;
            const points = edge.geometry && edge.geometry.length > 1
              ? edge.geometry
              : [nodes.get(edge.from), nodes.get(edge.to)]
                .filter((node): node is NonNullable<typeof node> => Boolean(node))
                .map(node => [node.x, node.y]);
            if (points.length < 2) return null;
            return (
              <polyline
                key={edge.id}
                className={`graph-edge ${visible ? '' : 'graph-edge--hidden'}`}
                points={points.map(point => point.join(',')).join(' ')}
                style={selectedEdge === edge.id ? { stroke: '#f59e0b', strokeWidth: 4 } : undefined}
                onClick={() => onSelectEdge?.(edge.id)}
              />
            );
          })}
        </g>
        {showCrossings ? (
          <g>
            {graph.crossings.map((crossing, index) => (
              <circle
                key={index}
                className="graph-crossing"
                cx={crossing.x}
                cy={crossing.y}
                r="9"
                strokeDasharray="3 2"
              />
            ))}
          </g>
        ) : null}
        {showNodes ? (
          <g>
            {graph.nodes.map(node => (
              <g key={node.id}>
                <circle
                  className={`graph-node ${node.degree && node.degree > 2 ? 'graph-node--review' : ''}`}
                  cx={node.x}
                  cy={node.y}
                  r={node.degree && node.degree > 2 ? 8 : 5.5}
                />
                <text className="graph-label" x={node.x + 9} y={node.y - 7}>{node.id}</text>
              </g>
            ))}
          </g>
        ) : null}
      </svg>
    </div>
  );
}