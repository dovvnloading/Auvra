import * as THREE from 'three';
import { closestOnLiveSpline, liveSplineWorldScale, sampleLiveSpline, createWorldSplineFrame, type LiveSpline } from './splineRegistry';

/**
 * PATROL PATHS
 *
 * An enemy whose spawner names a patrol path (an object with a Spline component) patrols along it
 * instead of wandering: it joins the path where it is nearest, then walks it a waypoint at a time,
 * round and round a closed spline, or to one end of an open one and back again, pausing at each
 * end. The built-in AI and a behavior tree's Patrol action both take their waypoints from here.
 */

/** Metres between the waypoints an enemy walks to along its path. */
export const PATROL_WAYPOINT_SPACING = 3;

export interface PatrolWaypoint {
    point: THREE.Vector3;
    /** The path turned back here (the end of an open spline): a place to pause. */
    end: boolean;
}

export class SplinePatrol {
    /** Distance along the spline (its own units) of the waypoint last handed out; null before the first. */
    private distance: number | null = null;
    private direction: 1 | -1 = 1;
    private last: THREE.Vector3 | null = null;
    private readonly frame = createWorldSplineFrame();

    /** `path` finds the spline each time, so a path drawn after the enemy spawned (or redrawn) is still followed. */
    constructor(private readonly path: () => LiveSpline | null, private readonly spacing = PATROL_WAYPOINT_SPACING) {}

    /** Whether the path exists now. */
    get available(): boolean {
        const entry = this.path();
        return Boolean(entry && entry.spline.length > 1e-6);
    }

    /** The waypoint after the last one, or (the first time) the point on the path nearest `position`; null without a path. */
    next(position: THREE.Vector3): PatrolWaypoint | null {
        const entry = this.path();
        if (!entry || !(entry.spline.length > 1e-6)) return null;
        const { spline } = entry;
        let end = false;
        // Far from the last waypoint (it chased the player, or was pushed): join the path afresh.
        if (this.distance !== null && this.last && flatDistance(this.last, position) > this.spacing * 3) this.distance = null;
        if (this.distance === null) {
            this.distance = closestOnLiveSpline(entry, position);
            // Head for the longer stretch of an open path first.
            if (!spline.closed) this.direction = this.distance > spline.length / 2 ? -1 : 1;
        } else {
            const step = this.spacing / liveSplineWorldScale(entry);
            let distance = this.distance + step * this.direction;
            if (spline.closed) {
                distance = ((distance % spline.length) + spline.length) % spline.length;
            } else if (distance >= spline.length - step * 1e-3 || distance <= step * 1e-3) {
                distance = Math.min(spline.length, Math.max(0, distance));
                end = true;
                this.direction = this.direction === 1 ? -1 : 1;
            }
            this.distance = distance;
        }
        sampleLiveSpline(entry, this.distance, this.frame);
        this.last = this.frame.position.clone();
        return { point: this.frame.position.clone(), end };
    }

    /** Forgets where it was, so the next waypoint is the nearest point again (after a chase, say). */
    rejoin(): void {
        this.distance = null;
        this.last = null;
    }
}

const flatDistance = (a: THREE.Vector3, b: THREE.Vector3): number => Math.hypot(a.x - b.x, a.z - b.z);
