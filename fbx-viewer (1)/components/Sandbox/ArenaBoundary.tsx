import React from 'react';
import { Line } from '@react-three/drei';

interface ArenaBoundaryProps {
    boundarySize: number;
}

/** The Sandbox arena's edge, which its enemies are kept inside (the Sandbox has no navmesh). */
export const ArenaBoundary: React.FC<ArenaBoundaryProps> = ({ boundarySize }) => {
  const half = boundarySize;
  const points: [number, number, number][] = [
    [-half, 0.1, -half],
    [half, 0.1, -half],
    [half, 0.1, half],
    [-half, 0.1, half],
    [-half, 0.1, -half], // Close loop
  ];

  return (
    <group>
        {/* Glowing Boundary Line */}
        <Line 
            points={points} 
            color="#ef4444" 
            lineWidth={3} 
            dashed={false}
            opacity={0.8}
            transparent
        />
        {/* Floor Tint for Safe Zone */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.05, 0]}>
            <planeGeometry args={[boundarySize * 2, boundarySize * 2]} />
            <meshBasicMaterial color="#ef4444" opacity={0.05} transparent depthWrite={false} />
        </mesh>
    </group>
  );
};