import { CubeCoord, cubeDistance, cubeToPixel } from '../utils/HexUtils';
import { HexGrid } from './HexGrid';
import { HexTile } from './HexTile';

interface PathNode {
  tile: HexTile;
  g: number; // Cost from start
  h: number; // Heuristic (estimated cost to goal)
  f: number; // Total cost (g + h)
  parent: PathNode | null;
}

/**
 * Calculate the perpendicular distance from a point to a line defined by two points.
 * This measures how far "off course" a position is from the direct path.
 */
function crossTrackDistance(
  point: { x: number; y: number },
  lineStart: { x: number; y: number },
  lineEnd: { x: number; y: number }
): number {
  const dx = lineEnd.x - lineStart.x;
  const dy = lineEnd.y - lineStart.y;
  const lineLengthSq = dx * dx + dy * dy;

  // If start and end are the same point, just return distance to that point
  if (lineLengthSq === 0) {
    const pdx = point.x - lineStart.x;
    const pdy = point.y - lineStart.y;
    return Math.sqrt(pdx * pdx + pdy * pdy);
  }

  // Calculate perpendicular distance using cross product
  // |((lineEnd - lineStart) × (lineStart - point))| / |lineEnd - lineStart|
  const cross = Math.abs(dx * (lineStart.y - point.y) - dy * (lineStart.x - point.x));
  return cross / Math.sqrt(lineLengthSq);
}

/**
 * A* pathfinding implementation for hex grids.
 */
export class HexPathfinder {
  private grid: HexGrid;

  constructor(grid: HexGrid) {
    this.grid = grid;
  }

  /**
   * Find a path from start to goal using A*.
   * Returns an array of tiles from start to goal (inclusive), or null if no path exists.
   */
  findPath(start: CubeCoord, goal: CubeCoord): HexTile[] | null {
    const startTile = this.grid.getTile(start);
    const goalTile = this.grid.getTile(goal);

    if (!startTile || !goalTile) {
      return null;
    }

    if (!goalTile.isTraversable) {
      return null;
    }

    // If start equals goal, return just the start tile
    if (startTile.key === goalTile.key) {
      return [startTile];
    }

    // Pre-compute the ideal line from start to goal in pixel coordinates
    const startPixel = cubeToPixel(start);
    const goalPixel = cubeToPixel(goal);

    const openSet: Map<string, PathNode> = new Map();
    const closedSet: Set<string> = new Set();

    const startNode: PathNode = {
      tile: startTile,
      g: 0,
      h: cubeDistance(start, goal),
      f: cubeDistance(start, goal),
      parent: null,
    };

    openSet.set(startTile.key, startNode);

    while (openSet.size > 0) {
      // Get node with lowest f score
      let current: PathNode | null = null;
      let lowestF = Infinity;

      for (const node of openSet.values()) {
        if (node.f < lowestF) {
          lowestF = node.f;
          current = node;
        }
      }

      if (!current) break;

      // Check if we reached the goal
      if (current.tile.key === goalTile.key) {
        return this.reconstructPath(current);
      }

      // Move current from open to closed
      openSet.delete(current.tile.key);
      closedSet.add(current.tile.key);

      // Check all traversable neighbors
      const neighbors = this.grid.getTraversableNeighbors(current.tile.coord);

      for (const neighbor of neighbors) {
        if (closedSet.has(neighbor.key)) {
          continue;
        }

        // Calculate cross-track distance as a small tie-breaker
        // This prefers paths that stay close to the ideal straight line
        const neighborPixel = cubeToPixel(neighbor.coord);
        const crossTrack = crossTrackDistance(neighborPixel, startPixel, goalPixel);
        // Scale it down significantly so it only breaks ties, doesn't affect path length
        const tieBreaker = crossTrack * 0.0001;

        const tentativeG = current.g + 1 + tieBreaker;

        const existingNode = openSet.get(neighbor.key);

        if (!existingNode) {
          // New node discovered
          const h = cubeDistance(neighbor.coord, goal);
          const newNode: PathNode = {
            tile: neighbor,
            g: tentativeG,
            h,
            f: tentativeG + h,
            parent: current,
          };
          openSet.set(neighbor.key, newNode);
        } else if (tentativeG < existingNode.g) {
          // Found a better path to this node
          existingNode.g = tentativeG;
          existingNode.f = tentativeG + existingNode.h;
          existingNode.parent = current;
        }
      }
    }

    // No path found
    return null;
  }

  /**
   * Reconstruct the path from goal to start by following parent pointers.
   */
  private reconstructPath(goalNode: PathNode): HexTile[] {
    const path: HexTile[] = [];
    let current: PathNode | null = goalNode;

    while (current) {
      path.unshift(current.tile);
      current = current.parent;
    }

    return path;
  }

  /**
   * Check if a path exists between two points.
   */
  hasPath(start: CubeCoord, goal: CubeCoord): boolean {
    return this.findPath(start, goal) !== null;
  }

  /**
   * Get the distance of the shortest path (in tiles).
   * Returns -1 if no path exists.
   */
  getPathLength(start: CubeCoord, goal: CubeCoord): number {
    const path = this.findPath(start, goal);
    return path ? path.length - 1 : -1; // Subtract 1 because path includes start tile
  }
}
