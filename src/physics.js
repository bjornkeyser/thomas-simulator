import * as CANNON from 'cannon-es';
import * as THREE from 'three';

export class PhysicsWorld {
    constructor() {
        // Create physics world
        this.world = new CANNON.World();
        this.world.gravity.set(0, -9.82, 0);
        this.world.broadphase = new CANNON.NaiveBroadphase();
        this.world.solver.iterations = 10;

        // Track physics bodies and their Three.js counterparts
        this.bodies = new Map(); // Map<THREE.Object3D, CANNON.Body>
        this.dynamicBodies = []; // Bodies that need syncing

        // Grabbing state
        this.grabbedBody = null;
        this.grabbedMesh = null;
        this.grabConstraint = null;
        this.grabPointBody = null; // Kinematic body for mouse position

        // Raycaster for mouse picking
        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();
        this.grabPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
        this.grabOffset = new THREE.Vector3();
        this.grabHeight = 0;

        // Constraint-based grabbing (for cigarette tumbling)
        this.jointBody = null;
        this.jointConstraint = null;
        this.useConstraintGrab = false; // True for cigarette, false for cup
        this.constraintPaused = false; // True when temporarily in kinematic mode for smoking
        this.localGrabPoint = new CANNON.Vec3(); // Where on the body we grabbed

        // Mouth-based grab system
        this.initialGrabMouseY = 0;
        this.initialGrabDistance = 0;
        this.currentGrabDistance = 0;
        this.isNearMouth = false;
        this.mouthThreshold = 0.35; // Distance to trigger drink/smoke
        this.depthProgress = 0; // 0 = at table, 1 = at mouth
        this.laggedPosition = null; // For smoking lag effect

        // Track velocity for release momentum
        this.prevGrabPosition = null;
        this.grabVelocity = new THREE.Vector3();

        // Breakable objects and collision callbacks
        this.breakableObjects = new Map(); // mesh -> { body, threshold, onBreak }
        this.pendingBreaks = []; // Deferred break operations
        this.setupCollisionDetection();
    }

    /**
     * Setup collision detection for breakable objects
     */
    setupCollisionDetection() {
        // Use collision events for reliable impact detection
        this.world.addEventListener('beginContact', (event) => {
            const bodyA = event.bodyA;
            const bodyB = event.bodyB;

            // Check if either body is breakable
            for (const [mesh, config] of this.breakableObjects) {
                const body = config.body;
                if (!body) continue;

                // Skip if currently grabbed
                if (body.type === CANNON.Body.KINEMATIC) continue;

                // Check if this breakable was involved in collision
                if (body === bodyA || body === bodyB) {
                    const otherBody = body === bodyA ? bodyB : bodyA;

                    // Calculate relative impact velocity
                    const relativeVelocity = new CANNON.Vec3();
                    body.velocity.vsub(otherBody.velocity, relativeVelocity);
                    const impactSpeed = relativeVelocity.length();

                    // Only break on ground collision (y < 0.3) or fragment collision
                    // Table is at y ~ 0.75, so cups landing on table shouldn't break
                    const isGround = otherBody.mass === 0 && otherBody.position.y < 0.3;
                    const isFragment = otherBody.mass > 0 && otherBody.mass < 0.1; // Fragments have mass 0.05

                    if (isGround || isFragment) {
                        console.log('Collision! Speed:', impactSpeed.toFixed(2), 'threshold:', config.threshold,
                            isFragment ? '(fragment)' : '(ground)');

                        if (impactSpeed > config.threshold) {
                            const impactPoint = new THREE.Vector3(
                                body.position.x,
                                body.position.y,
                                body.position.z
                            );
                            console.log('BREAK! Impact speed:', impactSpeed.toFixed(2));
                            // Defer the break to after physics step
                            this.pendingBreaks.push({ mesh, body, impactPoint, impactSpeed, config });
                            this.breakableObjects.delete(mesh);
                        }
                    }
                }
            }
        });
    }

    /**
     * Process any pending break operations (call after physics step)
     */
    processPendingBreaks() {
        for (const { mesh, body, impactPoint, impactSpeed, config } of this.pendingBreaks) {
            if (config.onBreak) {
                config.onBreak(mesh, body, impactPoint, impactSpeed);
            }
        }
        this.pendingBreaks = [];
    }

    /**
     * Register a mesh as breakable
     */
    registerBreakable(mesh, threshold = 3.0, onBreak = null) {
        const body = this.bodies.get(mesh);
        if (body) {
            this.breakableObjects.set(mesh, {
                body: body,
                threshold: threshold,
                onBreak: (m, b, point, force) => {
                    // Clean up from tracking
                    this.bodies.delete(m);
                    this.dynamicBodies = this.dynamicBodies.filter(d => d.mesh !== m);

                    // Call user callback
                    if (onBreak) onBreak(m, b, point, force);
                },
                prevVelocity: 0
            });
            console.log('Registered breakable:', mesh.name, 'threshold:', threshold);
        }
    }

    /**
     * Create a static box collider from a Three.js object's bounding box
     * Computes the actual bounding box of the model for accurate collision
     */
    createStaticFromBoundingBox(object3D) {
        // Compute the world bounding box
        const box = new THREE.Box3().setFromObject(object3D);
        const size = new THREE.Vector3();
        const center = new THREE.Vector3();
        box.getSize(size);
        box.getCenter(center);

        console.log('Bounding box for', object3D.name, '- center:', center, 'size:', size);

        // Create Cannon box shape
        const shape = new CANNON.Box(new CANNON.Vec3(size.x / 2, size.y / 2, size.z / 2));

        const body = new CANNON.Body({
            mass: 0, // Static
            position: new CANNON.Vec3(center.x, center.y, center.z),
        });
        body.addShape(shape);

        this.world.addBody(body);
        this.bodies.set(object3D, body);

        return body;
    }

    /**
     * Create just a top surface collider from a Three.js object
     * Uses the bounding box but only the top surface (thin box)
     * @param shrinkFactor - shrink the X/Z dimensions (default 1.0 = full size, 0.8 = 80%)
     * @param rotationY - Y-axis rotation in radians (default 0)
     */
    createStaticSurface(object3D, shrinkFactor = 1.0, rotationY = 0) {
        // Compute the world bounding box
        const box = new THREE.Box3().setFromObject(object3D);
        const size = new THREE.Vector3();
        const center = new THREE.Vector3();
        box.getSize(size);
        box.getCenter(center);

        console.log('Surface collider for', object3D.name, '- top at y:', box.max.y, 'size:', size);

        // Create thin box at the top surface (with optional shrink)
        const surfaceThickness = 0.02;
        const shape = new CANNON.Box(new CANNON.Vec3(
            size.x / 2 * shrinkFactor,
            surfaceThickness / 2,
            size.z / 2 * shrinkFactor
        ));

        const body = new CANNON.Body({
            mass: 0, // Static
            position: new CANNON.Vec3(center.x, box.max.y - surfaceThickness / 2, center.z),
        });

        // Apply Y rotation
        if (rotationY !== 0) {
            body.quaternion.setFromEuler(0, rotationY, 0);
        }

        body.addShape(shape);

        this.world.addBody(body);
        this.bodies.set(object3D, body);

        return body;
    }

    /**
     * Create a wireframe debug mesh for box collider
     */
    createBoxDebugMesh(sizeX, sizeY, sizeZ, posX, posY, posZ, scene) {
        const geometry = new THREE.BoxGeometry(sizeX, sizeY, sizeZ);
        const material = new THREE.MeshBasicMaterial({
            color: 0x00ff00,
            wireframe: true,
            transparent: true,
            opacity: 0.5
        });
        const debugMesh = new THREE.Mesh(geometry, material);
        debugMesh.position.set(posX, posY, posZ);
        debugMesh.name = 'box-debug';
        scene.add(debugMesh);
        return debugMesh;
    }

    /**
     * Create a trimesh collider from a Three.js mesh (uses actual geometry)
     */
    createStaticTrimesh(object3D) {
        const vertices = [];
        const indices = [];

        // Traverse and collect geometry
        object3D.traverse((child) => {
            if (child.isMesh && child.geometry) {
                const geo = child.geometry;
                const pos = geo.attributes.position;
                const idx = geo.index;

                // Get world matrix
                child.updateWorldMatrix(true, false);
                const matrix = child.matrixWorld;

                const vertexOffset = vertices.length / 3;

                // Add vertices (transformed to world space)
                for (let i = 0; i < pos.count; i++) {
                    const v = new THREE.Vector3(
                        pos.getX(i),
                        pos.getY(i),
                        pos.getZ(i)
                    ).applyMatrix4(matrix);
                    vertices.push(v.x, v.y, v.z);
                }

                // Add indices
                if (idx) {
                    for (let i = 0; i < idx.count; i++) {
                        indices.push(idx.getX(i) + vertexOffset);
                    }
                } else {
                    // Non-indexed geometry
                    for (let i = 0; i < pos.count; i++) {
                        indices.push(i + vertexOffset);
                    }
                }
            }
        });

        if (vertices.length === 0) {
            console.warn('No geometry found for trimesh:', object3D.name);
            return null;
        }

        console.log('Trimesh collider for', object3D.name, '- vertices:', vertices.length / 3, 'triangles:', indices.length / 3);

        const shape = new CANNON.Trimesh(vertices, indices);
        const body = new CANNON.Body({
            mass: 0, // Static
            position: new CANNON.Vec3(0, 0, 0),
        });
        body.addShape(shape);

        this.world.addBody(body);
        this.bodies.set(object3D, body);

        // Create debug visualization
        this.createTrimeshDebugMesh(vertices, indices, object3D.parent);

        return body;
    }

    /**
     * Create a wireframe debug mesh to visualize trimesh collider
     */
    createTrimeshDebugMesh(vertices, indices, scene) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        geometry.setIndex(indices);

        const material = new THREE.MeshBasicMaterial({
            color: 0x00ff00,
            wireframe: true,
            transparent: true,
            opacity: 0.5
        });

        const debugMesh = new THREE.Mesh(geometry, material);
        debugMesh.name = 'trimesh-debug';
        scene.add(debugMesh);

        console.log('Debug trimesh mesh added (green wireframe)');
        return debugMesh;
    }

    /**
     * Create a static box collider (for table, floor)
     */
    createStaticBox(mesh, size, position) {
        const shape = new CANNON.Box(new CANNON.Vec3(size.x / 2, size.y / 2, size.z / 2));
        const body = new CANNON.Body({
            mass: 0, // Static
            position: new CANNON.Vec3(position.x, position.y, position.z),
            shape: shape
        });
        this.world.addBody(body);
        if (mesh) {
            this.bodies.set(mesh, body);
        }
        return body;
    }

    /**
     * Create a dynamic box collider
     */
    createDynamicBox(mesh, size, mass = 1) {
        const shape = new CANNON.Box(new CANNON.Vec3(size.x / 2, size.y / 2, size.z / 2));
        const pos = mesh.position;
        const body = new CANNON.Body({
            mass: mass,
            position: new CANNON.Vec3(pos.x, pos.y, pos.z),
            shape: shape,
            linearDamping: 0.3,
            angularDamping: 0.5
        });

        // Copy rotation
        const quat = mesh.quaternion;
        body.quaternion.set(quat.x, quat.y, quat.z, quat.w);

        this.world.addBody(body);
        this.bodies.set(mesh, body);
        this.dynamicBodies.push({ mesh, body });
        return body;
    }

    /**
     * Create a dynamic cylinder collider (good for cups)
     */
    createDynamicCylinder(mesh, radius, height, mass = 1) {
        const shape = new CANNON.Cylinder(radius, radius, height, 12);
        const pos = mesh.position;
        const body = new CANNON.Body({
            mass: mass,
            position: new CANNON.Vec3(pos.x, pos.y, pos.z),
            shape: shape,
            linearDamping: 0.3,
            angularDamping: 0.5
        });

        // Copy rotation
        const quat = mesh.quaternion;
        body.quaternion.set(quat.x, quat.y, quat.z, quat.w);

        this.world.addBody(body);
        this.bodies.set(mesh, body);
        this.dynamicBodies.push({ mesh, body });
        return body;
    }

    /**
     * Get the physics body for a mesh
     */
    getBody(mesh) {
        return this.bodies.get(mesh);
    }

    /**
     * Check if mouse is hovering over a grabbable object
     */
    checkHover(mouseX, mouseY, camera, grabbableMeshes) {
        this.mouse.x = (mouseX / window.innerWidth) * 2 - 1;
        this.mouse.y = -(mouseY / window.innerHeight) * 2 + 1;

        this.raycaster.setFromCamera(this.mouse, camera);
        const intersects = this.raycaster.intersectObjects(grabbableMeshes, true);

        if (intersects.length > 0) {
            // Find the root grabbable object
            let target = intersects[0].object;
            while (target.parent && !grabbableMeshes.includes(target)) {
                target = target.parent;
            }
            const body = this.bodies.get(target);
            return body && body.mass > 0;
        }
        return false;
    }

    /**
     * Try to grab an object at mouse position
     */
    tryGrab(mouseX, mouseY, camera, grabbableMeshes) {
        this.mouse.x = (mouseX / window.innerWidth) * 2 - 1;
        this.mouse.y = -(mouseY / window.innerHeight) * 2 + 1;

        this.raycaster.setFromCamera(this.mouse, camera);

        const intersects = this.raycaster.intersectObjects(grabbableMeshes, true);

        if (intersects.length > 0) {
            // Find the root grabbable object
            let target = intersects[0].object;
            while (target.parent && !grabbableMeshes.includes(target)) {
                target = target.parent;
            }

            const body = this.bodies.get(target);
            if (body && body.mass > 0) {
                this.grabbedMesh = target;
                this.grabbedBody = body;

                // Store grab height and offset
                this.grabHeight = intersects[0].point.y;
                this.grabOffset.copy(intersects[0].point).sub(target.position);

                // Store initial mouse Y and distance for mouth-based movement
                this.initialGrabMouseY = this.mouse.y;
                this.initialGrabDistance = camera.position.distanceTo(target.position);
                this.currentGrabDistance = this.initialGrabDistance;
                this.isNearMouth = false;
                this.camera = camera; // Store camera reference

                // Wake up the body
                body.wakeUp();

                // Use constraint-based grab for cigarette (natural tumbling)
                const isCigarette = target.name === 'cigarette';
                this.useConstraintGrab = isCigarette;

                if (this.useConstraintGrab) {
                    // Calculate local grab point on the body
                    const hitPoint = intersects[0].point;
                    const localPoint = new CANNON.Vec3(
                        hitPoint.x - body.position.x,
                        hitPoint.y - body.position.y,
                        hitPoint.z - body.position.z
                    );
                    // Transform to body's local space
                    body.quaternion.conjugate().vmult(localPoint, this.localGrabPoint);

                    // Create kinematic joint body at hit point
                    this.jointBody = new CANNON.Body({
                        type: CANNON.Body.KINEMATIC,
                        mass: 0,
                        position: new CANNON.Vec3(hitPoint.x, hitPoint.y, hitPoint.z)
                    });
                    this.world.addBody(this.jointBody);

                    // Create point-to-point constraint
                    this.jointConstraint = new CANNON.PointToPointConstraint(
                        body,
                        this.localGrabPoint,
                        this.jointBody,
                        new CANNON.Vec3(0, 0, 0),
                        100 // Force strength
                    );
                    this.world.addConstraint(this.jointConstraint);

                    // Keep body dynamic for natural physics
                    body.linearDamping = 0.9;
                    body.angularDamping = 0.9;
                } else {
                    // Make body kinematic while grabbed (cup behavior)
                    body.type = CANNON.Body.KINEMATIC;
                }

                console.log('Grabbed:', target.name, this.useConstraintGrab ? '(constraint)' : '(kinematic)');
                return true;
            }
        }
        return false;
    }

    /**
     * Update grabbed object position based on mouse
     * Dragging down brings object closer to camera (toward mouth)
     * Uses a slanted plane from table to mouth
     * @param drinkScore - causes hand shake
     * @param smokeScore - causes movement lag
     */
    updateGrab(mouseX, mouseY, camera, drinkScore = 0, smokeScore = 0) {
        if (!this.grabbedBody) return;

        this.mouse.x = (mouseX / window.innerWidth) * 2 - 1;
        this.mouse.y = -(mouseY / window.innerHeight) * 2 + 1;

        this.raycaster.setFromCamera(this.mouse, camera);

        // Intersect with horizontal plane at grab height for X/Z positioning
        this.grabPlane.set(new THREE.Vector3(0, 1, 0), -this.grabHeight);
        const intersection = new THREE.Vector3();
        this.raycaster.ray.intersectPlane(this.grabPlane, intersection);

        if (intersection) {
            // Calculate how much mouse moved down from initial grab
            const mouseYDelta = this.initialGrabMouseY - this.mouse.y; // Positive when dragging down

            // Map mouse Y to depth: dragging down = closer to camera
            // 0 = at table, 1 = at mouth (more sensitive)
            this.depthProgress = Math.max(0, Math.min(1, mouseYDelta * 2.0));

            // Different mouth positions for cup vs cigarette
            const isCigarette = this.grabbedMesh?.name === 'cigarette';
            const mouthY = isCigarette ? -0.15 : -0.075; // Cigarette lower
            const mouthZ = isCigarette ? -0.25 : -0.15; // Cup closer to face
            const mouthPos = new THREE.Vector3(0, mouthY, mouthZ);
            camera.localToWorld(mouthPos);

            // Lerp between table intersection and mouth position
            const targetPos = new THREE.Vector3();
            targetPos.lerpVectors(intersection, mouthPos, this.depthProgress);

            // Adjust height to follow slanted path (table height to mouth height)
            targetPos.y = THREE.MathUtils.lerp(this.grabHeight, mouthPos.y, this.depthProgress);

            // Apply smoking lag effect FIRST (more smoke = more lag)
            // lagFactor is how much it moves toward target per frame (lower = more lag)
            const lagFactor = Math.max(0.03, 1 - smokeScore * 0.25); // Much more aggressive lag
            if (!this.laggedPosition) {
                this.laggedPosition = targetPos.clone();
            }
            this.laggedPosition.lerp(targetPos, lagFactor);

            // Apply coffee shake effect AFTER lag (so jitter shows on top of sluggish movement)
            // Small amplitude, high frequency for jittery hands
            const finalPos = this.laggedPosition.clone();
            if (drinkScore > 0) {
                const shakeIntensity = Math.min(drinkScore * 0.002, 0.008); // Subtle shake
                const time = performance.now() * 0.025; // High frequency
                finalPos.x += Math.sin(time * 4.1) * shakeIntensity;
                finalPos.y += Math.sin(time * 5.3) * shakeIntensity * 0.6;
                finalPos.z += Math.cos(time * 3.7) * shakeIntensity;
            }

            // Track velocity for release momentum
            if (this.prevGrabPosition) {
                this.grabVelocity.subVectors(finalPos, this.prevGrabPosition).multiplyScalar(60); // Approximate velocity
            }
            if (!this.prevGrabPosition) {
                this.prevGrabPosition = new THREE.Vector3();
            }
            this.prevGrabPosition.copy(finalPos);

            if (this.useConstraintGrab) {
                // Check if we should switch to kinematic mode for smoking
                // Once in kinematic mode, stay there until release (no going back)
                if (this.depthProgress > 0.6 && !this.constraintPaused && this.jointBody) {
                    // Switch to kinematic mode - remove constraint
                    this.world.removeConstraint(this.jointConstraint);
                    this.world.removeBody(this.jointBody);
                    this.jointBody = null;
                    this.jointConstraint = null;
                    this.grabbedBody.type = CANNON.Body.KINEMATIC;
                    this.grabbedBody.velocity.set(0, 0, 0);
                    this.grabbedBody.angularVelocity.set(0, 0, 0);
                    this.constraintPaused = true;
                }

                if (this.constraintPaused) {
                    // Kinematic mode: direct MESH control (body will sync FROM mesh in update)
                    // Set body position for physics consistency
                    this.grabbedBody.position.set(finalPos.x, finalPos.y, finalPos.z);
                    this.grabbedBody.velocity.set(0, 0, 0);
                    this.grabbedBody.angularVelocity.set(0, 0, 0);

                    // Apply smoking rotation directly to MESH
                    const camDir = new THREE.Vector3();
                    camera.getWorldDirection(camDir);
                    const yaw = Math.atan2(camDir.x, camDir.z);

                    // Target smoking pose
                    const targetRotY = yaw - Math.PI / 2; // Point right
                    const targetRotZ = 0.2; // Slight tilt

                    const currentQuat = this.grabbedMesh.quaternion.clone();
                    const targetQuat = new THREE.Quaternion().setFromEuler(
                        new THREE.Euler(0, targetRotY, targetRotZ)
                    );
                    currentQuat.slerp(targetQuat, 0.15);

                    // Set mesh directly
                    this.grabbedMesh.quaternion.copy(currentQuat);
                    this.grabbedMesh.position.copy(finalPos);

                    // Sync body from mesh
                    this.grabbedBody.quaternion.set(currentQuat.x, currentQuat.y, currentQuat.z, currentQuat.w);
                } else if (this.jointBody) {
                    // Constraint mode: move joint body, physics handles the rest
                    this.jointBody.position.set(finalPos.x, finalPos.y, finalPos.z);
                }
            } else {
                // Kinematic grab: directly set body position (cup behavior)
                this.grabbedBody.position.set(finalPos.x, finalPos.y, finalPos.z);
                this.grabbedBody.velocity.set(0, 0, 0);
            }

            // Track distance to mouth for triggering actions
            this.currentGrabDistance = targetPos.distanceTo(mouthPos);
            const wasNearMouth = this.isNearMouth;
            this.isNearMouth = this.depthProgress > 0.85;

            return this.isNearMouth && !wasNearMouth;
        }
    }

    /**
     * Release the grabbed object
     */
    release() {
        if (this.grabbedBody) {
            if (this.useConstraintGrab) {
                // Remove constraint and joint body (if not already removed due to pause)
                if (this.jointConstraint && !this.constraintPaused) {
                    this.world.removeConstraint(this.jointConstraint);
                }
                this.jointConstraint = null;

                if (this.jointBody) {
                    this.world.removeBody(this.jointBody);
                    this.jointBody = null;
                }

                // Make sure body is dynamic
                this.grabbedBody.type = CANNON.Body.DYNAMIC;

                // Reset damping to normal
                this.grabbedBody.linearDamping = 0.3;
                this.grabbedBody.angularDamping = 0.5;

                // Wake it up
                this.grabbedBody.wakeUp();

                this.constraintPaused = false;
            } else {
                // Make body dynamic again (was kinematic)
                this.grabbedBody.type = CANNON.Body.DYNAMIC;

                // Apply release velocity for momentum
                if (this.grabVelocity) {
                    this.grabbedBody.velocity.set(
                        this.grabVelocity.x * 0.5,
                        this.grabVelocity.y * 0.5,
                        this.grabVelocity.z * 0.5
                    );

                    // Add angular velocity based on linear velocity for tumbling
                    const angularScale = 3;
                    this.grabbedBody.angularVelocity.set(
                        (Math.random() - 0.5) * angularScale + this.grabVelocity.z * 0.5,
                        (Math.random() - 0.5) * angularScale,
                        (Math.random() - 0.5) * angularScale - this.grabVelocity.x * 0.5
                    );
                }

                this.grabbedBody.wakeUp();
            }

            console.log('Released:', this.grabbedMesh?.name);
            this.grabbedBody = null;
            this.grabbedMesh = null;
            this.useConstraintGrab = false;
            this.laggedPosition = null; // Reset lag effect
            this.prevGrabPosition = null;
            this.grabVelocity.set(0, 0, 0);
        }
    }

    /**
     * Check if currently grabbing something
     */
    isGrabbing() {
        return this.grabbedBody !== null;
    }

    /**
     * Get the currently grabbed mesh
     */
    getGrabbedMesh() {
        return this.grabbedMesh;
    }

    /**
     * Update physics simulation and sync with Three.js
     */
    update(deltaTime) {
        // Step physics
        this.world.step(1 / 60, deltaTime, 3);

        // Process any deferred break operations after physics step
        this.processPendingBreaks();

        // Sync Three.js objects with physics bodies
        for (const { mesh, body } of this.dynamicBodies) {
            // Skip syncing for paused constraint grab (kinematic smoking mode)
            // - updateGrab controls mesh directly in that mode
            if (mesh === this.grabbedMesh && this.constraintPaused) {
                continue;
            }

            // Always sync position from body
            mesh.position.copy(body.position);
            // For constraint grab, sync rotation from physics (natural tumbling)
            // For kinematic grab (cup), don't sync rotation (hands.js controls it)
            if (mesh !== this.grabbedMesh || this.useConstraintGrab) {
                mesh.quaternion.copy(body.quaternion);
            }
        }
    }

    /**
     * Set position of a body directly
     */
    setBodyPosition(mesh, position) {
        const body = this.bodies.get(mesh);
        if (body) {
            body.position.set(position.x, position.y, position.z);
            body.velocity.set(0, 0, 0);
        }
    }

    /**
     * Make a body kinematic (controlled by code, not physics)
     */
    setKinematic(mesh, isKinematic) {
        const body = this.bodies.get(mesh);
        if (body) {
            body.type = isKinematic ? CANNON.Body.KINEMATIC : CANNON.Body.DYNAMIC;
            if (!isKinematic) {
                body.wakeUp();
            }
        }
    }
}
