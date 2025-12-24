import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';

export class FractureSystem {
    constructor(scene, physicsWorld) {
        this.scene = scene;
        this.physicsWorld = physicsWorld;
        this.fragments = [];
        this.fragmentBodies = [];
    }

    /**
     * Fracture a mesh into Voronoi-based fragments
     * @param {THREE.Mesh} mesh - The mesh to fracture
     * @param {CANNON.Body} body - The physics body to remove
     * @param {THREE.Vector3} impactPoint - Where the impact occurred
     * @param {number} impactForce - Force of impact for explosion
     * @param {number} numFragments - Number of fragments to create (default 8)
     */
    fracture(mesh, body, impactPoint, impactForce = 5, numFragments = 12) {
        // Get mesh world position and geometry
        const worldPos = new THREE.Vector3();
        mesh.getWorldPosition(worldPos);

        const worldQuat = new THREE.Quaternion();
        mesh.getWorldQuaternion(worldQuat);

        // Get bounding box of mesh
        const bbox = new THREE.Box3().setFromObject(mesh);
        const size = new THREE.Vector3();
        bbox.getSize(size);
        const center = new THREE.Vector3();
        bbox.getCenter(center);

        // Generate Voronoi seed points
        const seeds = this.generateSeeds(center, size, numFragments);

        // Get all vertices from the mesh in world space
        const vertices = this.extractVertices(mesh);

        if (vertices.length < 4) {
            console.warn('Not enough vertices to fracture');
            return;
        }

        // Assign vertices to nearest seed (Voronoi partitioning)
        const clusters = this.clusterVertices(vertices, seeds);

        // Get the material from original mesh (traverse to find it for GLB models)
        let originalMaterial = mesh.material;
        if (!originalMaterial) {
            mesh.traverse((child) => {
                if (child.isMesh && child.material && !originalMaterial) {
                    originalMaterial = child.material;
                }
            });
        }
        // Fallback to a default material if none found
        const baseColor = originalMaterial?.color?.getHex() || 0x8B4513;

        // Create fragment meshes from clusters
        for (let i = 0; i < seeds.length; i++) {
            const clusterVerts = clusters[i];

            // Need at least 4 points for a convex hull
            if (clusterVerts.length < 4) continue;

            // Add some interior points to make fragments more solid
            const expandedVerts = this.addInteriorPoints(clusterVerts, seeds[i], 0.3);

            try {
                // Create convex hull geometry
                const geometry = new ConvexGeometry(expandedVerts);

                if (!geometry.attributes.position || geometry.attributes.position.count < 4) {
                    continue;
                }

                // Create fragment mesh with ceramic-like material
                const material = new THREE.MeshStandardMaterial({
                    color: baseColor,
                    roughness: 0.7,
                    metalness: 0.1,
                    side: THREE.DoubleSide
                });

                const fragment = new THREE.Mesh(geometry, material);
                fragment.castShadow = true;
                fragment.receiveShadow = true;

                // Calculate fragment center
                const fragCenter = new THREE.Vector3();
                for (const v of clusterVerts) {
                    fragCenter.add(v);
                }
                fragCenter.divideScalar(clusterVerts.length);

                // Position fragment
                fragment.position.copy(fragCenter);

                // Center the geometry
                geometry.center();

                this.scene.add(fragment);
                this.fragments.push(fragment);

                // Create physics body for fragment using simple box shape
                // (ConvexPolyhedron is too finicky with generated geometry)
                geometry.computeBoundingBox();
                const bbox = geometry.boundingBox;
                const fragSize = new THREE.Vector3();
                bbox.getSize(fragSize);

                // Use box shape for simpler, more stable physics
                const shape = new CANNON.Box(new CANNON.Vec3(
                    Math.max(0.005, fragSize.x / 2),
                    Math.max(0.005, fragSize.y / 2),
                    Math.max(0.005, fragSize.z / 2)
                ));

                const fragBody = new CANNON.Body({
                    mass: 0.05, // Light fragments
                    position: new CANNON.Vec3(fragCenter.x, fragCenter.y, fragCenter.z),
                    shape: shape,
                    linearDamping: 0.3,
                    angularDamping: 0.3
                });

                // Apply gentle explosion force from impact point
                const dir = new THREE.Vector3().subVectors(fragCenter, impactPoint).normalize();

                // Much gentler explosion - ceramic shatters, doesn't explode
                const spreadSpeed = 0.5 + Math.random() * 1.0; // 0.5-1.5 m/s outward

                fragBody.velocity.set(
                    dir.x * spreadSpeed + (Math.random() - 0.5) * 0.5,
                    Math.random() * 1.5, // Small upward bounce
                    dir.z * spreadSpeed + (Math.random() - 0.5) * 0.5
                );

                fragBody.angularVelocity.set(
                    (Math.random() - 0.5) * 5,
                    (Math.random() - 0.5) * 5,
                    (Math.random() - 0.5) * 5
                );

                this.physicsWorld.addBody(fragBody);
                this.fragmentBodies.push({ mesh: fragment, body: fragBody });
            } catch (e) {
                console.warn('Failed to create fragment geometry:', e);
            }
        }

        // Remove original mesh and body
        this.scene.remove(mesh);
        if (body) {
            this.physicsWorld.removeBody(body);
        }

        console.log(`Fractured into ${this.fragments.length} pieces`);

        return this.fragments;
    }

    /**
     * Generate random seed points for Voronoi cells
     */
    generateSeeds(center, size, count) {
        const seeds = [];
        const margin = 0.8; // Keep seeds within 80% of bbox

        for (let i = 0; i < count; i++) {
            seeds.push(new THREE.Vector3(
                center.x + (Math.random() - 0.5) * size.x * margin,
                center.y + (Math.random() - 0.5) * size.y * margin,
                center.z + (Math.random() - 0.5) * size.z * margin
            ));
        }

        return seeds;
    }

    /**
     * Extract all vertices from mesh in world space
     */
    extractVertices(mesh) {
        const vertices = [];

        mesh.updateMatrixWorld(true);

        mesh.traverse((child) => {
            if (child.isMesh && child.geometry) {
                const geo = child.geometry;
                const pos = geo.attributes.position;

                for (let i = 0; i < pos.count; i++) {
                    const v = new THREE.Vector3(
                        pos.getX(i),
                        pos.getY(i),
                        pos.getZ(i)
                    );
                    // Transform to world space
                    v.applyMatrix4(child.matrixWorld);
                    vertices.push(v);
                }
            }
        });

        return vertices;
    }

    /**
     * Cluster vertices to nearest seed (Voronoi partitioning)
     */
    clusterVertices(vertices, seeds) {
        const clusters = seeds.map(() => []);

        for (const v of vertices) {
            let minDist = Infinity;
            let nearestIdx = 0;

            for (let i = 0; i < seeds.length; i++) {
                const dist = v.distanceTo(seeds[i]);
                if (dist < minDist) {
                    minDist = dist;
                    nearestIdx = i;
                }
            }

            clusters[nearestIdx].push(v.clone());
        }

        return clusters;
    }

    /**
     * Add interior points to make fragments more solid
     */
    addInteriorPoints(vertices, seed, scale) {
        const expanded = [...vertices];

        // Add the seed point itself
        expanded.push(seed.clone());

        // Add points between vertices and seed
        for (const v of vertices) {
            const mid = new THREE.Vector3().lerpVectors(v, seed, 0.5);
            expanded.push(mid);
        }

        return expanded;
    }

    /**
     * Generate face indices for convex geometry
     */
    generateConvexFaces(geometry) {
        const faces = [];
        const index = geometry.index;

        if (index) {
            for (let i = 0; i < index.count; i += 3) {
                faces.push([index.getX(i), index.getX(i + 1), index.getX(i + 2)]);
            }
        } else {
            // Non-indexed geometry
            const count = geometry.attributes.position.count;
            for (let i = 0; i < count; i += 3) {
                faces.push([i, i + 1, i + 2]);
            }
        }

        return faces;
    }

    /**
     * Update fragment physics
     */
    update() {
        for (const { mesh, body } of this.fragmentBodies) {
            mesh.position.copy(body.position);
            mesh.quaternion.copy(body.quaternion);
        }
    }

    /**
     * Clean up fragments after delay
     */
    cleanupAfterDelay(delay = 5000) {
        setTimeout(() => {
            for (const { mesh, body } of this.fragmentBodies) {
                this.scene.remove(mesh);
                this.physicsWorld.removeBody(body);
                mesh.geometry.dispose();
                mesh.material.dispose();
            }
            this.fragments = [];
            this.fragmentBodies = [];
            console.log('Fragments cleaned up');
        }, delay);
    }
}
